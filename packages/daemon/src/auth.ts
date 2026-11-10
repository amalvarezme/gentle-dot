import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuthEvent, AuthMethod, AuthPrompt, AuthProvider, ServerPayload } from "@gentle-dot/protocol";
import { CLAUDE_BRIDGE_PROVIDER, type ClaudeCodeAccount } from "./claude-code-account.ts";
import { presentText } from "./white-label.ts";

type PromptRequest = {
	type: AuthPrompt["kind"];
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string; description?: string }[];
	signal?: AbortSignal;
};

type EventRequest =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: PromptRequest): Promise<string>;
	notify(event: EventRequest): void;
}

/** The part of Pi's ModelRuntime the assistant uses for sign-in. */
export interface AuthRuntime {
	getProviders(): readonly {
		id: string;
		name: string;
		auth: { apiKey?: { name: string }; oauth?: { name: string } };
	}[];
	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string };
	login(
		providerId: string,
		type: AuthMethod,
		interaction: AuthInteraction,
		options?: { getDeviceId?: () => string },
	): Promise<unknown>;
	logout(providerId: string): Promise<void>;
	isUsingSubscription?(providerId: string): boolean;
	getAuth?(providerId: string): Promise<unknown>;
	/**
	 * The connected OpenAI API key, for voice (S30.2). Never the "Sign in with ChatGPT" token:
	 * OpenAI documents that sign-in does not support transcription.
	 */
	openAIApiKey?(): Promise<string | undefined>;
}

/** The assistant's own engine home: never the user's Gentle Shell or Pi home unless explicitly overridden. */
export function resolveAgentHome(env: NodeJS.ProcessEnv, dataDir: string): string {
	return resolve(env.GENTLE_DOT_AGENT_HOME ?? join(dataDir, "agent"));
}

export interface NanProviderConfig {
	id: string;
	name: string;
	baseUrl?: string;
	auth: {
		apiKey?: {
			name: string;
			login?(interaction: {
				signal: AbortSignal;
				prompt(req: { type: string; message: string; signal?: AbortSignal }): Promise<string>;
			}): Promise<{ type: string; key: string }>;
			resolve?(input: {
				ctx: { env(name: string): Promise<string | undefined> };
				credential?: { type: string; key?: string; access?: string };
				signal: AbortSignal;
			}): Promise<unknown>;
		};
		oauth?: {
			name: string;
			isSubscription?: boolean;
			loginLabel?: string;
			login(interaction: {
				signal: AbortSignal;
				prompt(req: { type: string; message: string; signal?: AbortSignal }): Promise<string>;
			}): Promise<{ type: string; access: string; refresh: string; expires: number }>;
			refresh(credential: unknown): Promise<unknown>;
			toAuth(credential: { access: string }): Promise<{ apiKey: string }>;
		};
	};
	refreshModels?(context: {
		credential?: { type: string; key?: string; access?: string };
		allowNetwork?: boolean;
		signal: AbortSignal;
		publish?: (opts: { update: () => void }) => Promise<void>;
	}): Promise<void>;
}

/**
 * Enhances gentle-pi's NaN provider config so users can sign in with their NaN Builders subscription
 * under "Use a subscription" as in Pi / Gentle Shell, while preserving API key compatibility.
 */
export function enhanceNanProviderConfig(base: NanProviderConfig): NanProviderConfig {
	return {
		...base,
		auth: {
			...base.auth,
			apiKey: base.auth?.apiKey
				? {
						...base.auth.apiKey,
						resolve: async (input) => {
							const effectiveCredential =
								input.credential?.type === "oauth" && input.credential.access
									? { type: "api_key", key: input.credential.access }
									: input.credential;
							return base.auth.apiKey?.resolve?.({ ...input, credential: effectiveCredential });
						},
					}
				: undefined,
			oauth: {
				name: "NaN Builders (subscription)",
				isSubscription: true,
				loginLabel: "Sign in with NaN Builders",
				async login(interaction) {
					interaction.signal.throwIfAborted();
					const entered = await interaction.prompt({
						type: "secret",
						message: "Enter NaN Builders subscription key",
						signal: interaction.signal,
					});
					interaction.signal.throwIfAborted();
					const key = entered.trim();
					if (!key) throw new Error("NaN Builders requires a non-empty subscription key");
					return {
						type: "oauth",
						access: key,
						refresh: key,
						expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
					};
				},
				async refresh(credential) {
					return credential;
				},
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
		refreshModels: async (context) => {
			if (!base.refreshModels) return;
			const apiKey =
				context.credential?.type === "api_key"
					? context.credential.key
					: context.credential?.type === "oauth"
						? context.credential.access
						: undefined;
			return base.refreshModels({
				...context,
				credential: apiKey ? { type: "api_key", key: apiKey } : undefined,
			});
		},
	};
}

/**
 * Providers the engine adds through its own extensions, so the Accounts screen can sign in to them
 * too: today NaN (gentle-pi's `nan-provider`). gentle-pi ships them as TypeScript inside
 * node_modules, which Node will not strip, so they load through jiti as the engine loads them.
 */
async function registerEngineProviders(runtime: {
	registerNativeProvider(provider: never): void;
}): Promise<void> {
	const { createJiti } = await import("jiti");
	// No transpile cache: in the packaged app the default one lands inside the signed bundle (S35.1).
	const jiti = createJiti(import.meta.url, { fsCache: false });
	const { createNanProviderConfig } = await jiti.import<{
		createNanProviderConfig: () => NanProviderConfig;
	}>("gentle-pi/lib/nan-provider.ts");
	// A provider object, as `pi.registerProvider(config)` passes it, is a native provider.
	const provider = enhanceNanProviderConfig(createNanProviderConfig());
	runtime.registerNativeProvider(provider as never);
}

/**
 * Subscriptions whose sign-in is a key, by provider, with the prompt shown for it. The engine's
 * provider (gentle-pi's NaN) reads only `api_key` credentials, so the key is saved as one.
 */
const SUBSCRIPTION_KEYS: Readonly<Record<string, string>> = { nan: "Enter NaN Builders subscription key" };

/** Pi's ModelRuntime on the assistant's home: same auth.json format and file locking as Gentle Shell. */
export async function createModelAuthRuntime(agentHome: string, cwd: string): Promise<AuthRuntime> {
	mkdirSync(agentHome, { recursive: true, mode: 0o700 });
	const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({
		authPath: join(agentHome, "auth.json"),
		modelsPath: join(agentHome, "models.json"),
		// Offline, but refreshed on create so credentials saved by other runtimes are visible.
		allowModelNetwork: false,
	});
	await registerEngineProviders(runtime);
	const settings = SettingsManager.create(cwd, agentHome);
	return {
		getProviders: () => runtime.getProviders() as unknown as ReturnType<AuthRuntime["getProviders"]>,
		getProviderAuthStatus: (providerId) => runtime.getProviderAuthStatus(providerId),
		login: (providerId, type, interaction) => {
			const subscriptionKey = SUBSCRIPTION_KEYS[providerId];
			// A subscription key is an API key: saved as one, so the engine's own provider can use it.
			if (type === "oauth" && subscriptionKey) {
				const asKey = {
					...interaction,
					prompt: (request: { message: string }) =>
						interaction.prompt({ ...request, message: subscriptionKey } as never),
				};
				return runtime.login(providerId, "api_key", asKey as never, {
					getDeviceId: () => settings.getOrCreateDeviceId(),
				});
			}
			return runtime.login(providerId, type, interaction as never, {
				getDeviceId: () => settings.getOrCreateDeviceId(),
			});
		},
		logout: (providerId) => runtime.logout(providerId),
		isUsingSubscription: (providerId) => runtime.isUsingSubscription(providerId),
		getAuth: (providerId) => runtime.getAuth(providerId),
		openAIApiKey: async () => {
			// Checked first: resolving a sign-in could refresh its token over the network.
			if ((await runtime.checkAuth("openai"))?.type !== "api_key") return undefined;
			return (await runtime.getAuth("openai"))?.auth.apiKey || undefined;
		},
	};
}

type Emit = (payload: ServerPayload) => void;

/** Sign-in methods the assistant never offers: a Claude subscription cannot be used legally from here. */
const UNSUPPORTED_METHODS: Readonly<Record<string, AuthMethod>> = { anthropic: "oauth" };

const isUnsupported = (providerId: string, method: AuthMethod) =>
	Object.hasOwn(UNSUPPORTED_METHODS, providerId) && UNSUPPORTED_METHODS[providerId] === method;

/** Why a sign-in or sign-out did not start; `message` is safe to show. */
export type AuthRefusal = { code: "auth_busy" | "auth_unsupported" | "unknown_provider"; message: string };

const REFUSALS = {
	busy: { code: "auth_busy", message: "Another sign-in is in progress. Finish or cancel it first." },
	unsupported: {
		code: "auth_unsupported",
		message: "Signing in with a Claude subscription is not supported. Use an Anthropic API key instead.",
	},
	unknown: { code: "unknown_provider", message: "That account is not available." },
	claudeCodeSignOut: {
		code: "auth_unsupported",
		message: "Claude uses your Claude Code sign-in. To sign out, run `claude auth logout` in a terminal.",
	},
} as const satisfies Record<string, AuthRefusal>;

interface Flow {
	id: string;
	providerId: string;
	owner: object;
	controller: AbortController;
	pending?: { resolve: (value: string) => void; reject: (error: Error) => void };
	/** Values the user typed in this flow; removed from anything logged. */
	answers: string[];
}

export interface AuthManagerOptions {
	runtime: () => Promise<AuthRuntime>;
	/** The user's Claude Code sign-in, when the claude-bridge is set up (Claude through Claude Code). */
	claudeCode?: ClaudeCodeAccount;
	log?: (line: string) => void;
}

/**
 * Runs sign-in flows for the UI. One flow at a time (OAuth callback ports are
 * shared), prompts go to the window that started it, and typed answers never
 * reach logs.
 */
export class AuthManager {
	private flow: Flow | undefined;
	private readonly options: AuthManagerOptions;
	onCredentialsChanged: () => void = () => {};

	constructor(options: AuthManagerOptions) {
		this.options = options;
	}

	async providers(): Promise<AuthProvider[]> {
		const runtime = await this.options.runtime();
		const listed = runtime.getProviders().flatMap((provider) => {
			const oauth = isUnsupported(provider.id, "oauth") ? undefined : provider.auth.oauth;
			const methods: AuthMethod[] = [];
			if (oauth) methods.push("oauth");
			if (provider.auth.apiKey && !isUnsupported(provider.id, "api_key")) methods.push("api_key");
			if (methods.length === 0) return [];
			const status = runtime.getProviderAuthStatus(provider.id);
			const entry: AuthProvider = {
				id: provider.id,
				name: provider.name,
				methods,
				configured: status.configured,
			};
			if (oauth) entry.oauthName = oauth.name;
			if (status.configured && status.source) entry.source = status.source;
			return [entry];
		});
		const claudeCode = this.options.claudeCode;
		if (!claudeCode) return listed;
		return [
			...listed,
			{
				id: CLAUDE_BRIDGE_PROVIDER,
				name: "Claude (Claude Code)",
				methods: ["oauth"],
				oauthName: "Claude (via Claude Code)",
				configured: await claudeCode.signedIn(),
				source: "claude-code",
			},
		];
	}

	/** Starts a flow, or says why it did not start. */
	start(owner: object, providerId: string, method: AuthMethod, emit: Emit): AuthRefusal | undefined {
		if (isUnsupported(providerId, method)) return REFUSALS.unsupported;
		if (this.flow) return REFUSALS.busy;
		const flow: Flow = {
			id: randomUUID(),
			providerId,
			owner,
			controller: new AbortController(),
			answers: [],
		};
		this.flow = flow;
		void this.run(flow, method, emit);
		return undefined;
	}

	/** Delivers the user's answer (or cancellation) to the prompt of a flow `owner` started. */
	reply(owner: object, flowId: string, answer: { value?: string; cancelled?: boolean }): boolean {
		const flow = this.flow;
		if (!flow || flow.id !== flowId || flow.owner !== owner) return false;
		if (answer.cancelled) {
			flow.controller.abort();
			return true;
		}
		if (!flow.pending || answer.value === undefined) return false;
		flow.answers.push(answer.value);
		const { resolve } = flow.pending;
		flow.pending = undefined;
		resolve(answer.value);
		return true;
	}

	/** A window that goes away takes its sign-in with it. */
	cancelOwnedBy(owner: object): void {
		if (this.flow?.owner === owner) this.flow.controller.abort();
	}

	/** Signs out of a listed provider, or says why not. */
	async logout(providerId: string): Promise<AuthRefusal | undefined> {
		if (providerId === CLAUDE_BRIDGE_PROVIDER && this.options.claudeCode) return REFUSALS.claudeCodeSignOut;
		const runtime = await this.options.runtime();
		if (!runtime.getProviders().some((provider) => provider.id === providerId)) return REFUSALS.unknown;
		await runtime.logout(providerId);
		this.log(`signed out of ${providerId}`);
		this.onCredentialsChanged();
		return undefined;
	}

	/** The connected OpenAI API key, read fresh; only for the daemon's own requests to OpenAI. */
	async openAIApiKey(): Promise<string | undefined> {
		const runtime = await this.options.runtime();
		return runtime.openAIApiKey?.();
	}

	/** True when at least one provider has a credential. */
	async hasAccount(): Promise<boolean> {
		const runtime = await this.options.runtime();
		return runtime.getProviders().some((provider) => runtime.getProviderAuthStatus(provider.id).configured);
	}

	private async run(flow: Flow, method: AuthMethod, emit: Emit): Promise<void> {
		const { signal } = flow.controller;
		signal.addEventListener("abort", () => {
			flow.pending?.reject(new Error("cancelled"));
			flow.pending = undefined;
		});
		const interaction: AuthInteraction = {
			signal,
			prompt: (request) =>
				new Promise<string>((resolvePrompt, rejectPrompt) => {
					if (signal.aborted) return rejectPrompt(new Error("cancelled"));
					flow.pending = { resolve: resolvePrompt, reject: rejectPrompt };
					const prompt: AuthPrompt = {
						flowId: flow.id,
						kind: request.type,
						message: presentText(request.message),
					};
					if (request.placeholder) prompt.placeholder = request.placeholder;
					if (request.options)
						prompt.options = request.options.map((o) => ({ ...o, label: presentText(o.label) }));
					emit({ type: "auth_prompt", prompt });
				}),
			notify: (event) => emit({ type: "auth_event", flowId: flow.id, event: toAuthEvent(event) }),
		};
		try {
			const claudeCode = flow.providerId === CLAUDE_BRIDGE_PROVIDER ? this.options.claudeCode : undefined;
			if (claudeCode) await claudeCode.login(interaction);
			else await (await this.options.runtime()).login(flow.providerId, method, interaction);
			this.log(`signed in to ${flow.providerId} (${method})`);
			emit({ type: "auth_done", flowId: flow.id, providerId: flow.providerId, ok: true });
			this.flow = undefined;
			this.onCredentialsChanged();
		} catch (error) {
			const cancelled = signal.aborted;
			if (!cancelled)
				this.log(`sign-in to ${flow.providerId} failed: ${redact((error as Error).message, flow.answers)}`);
			emit({
				type: "auth_done",
				flowId: flow.id,
				providerId: flow.providerId,
				ok: false,
				message: cancelled ? "Sign-in cancelled." : "Sign-in did not finish. Please try again.",
			});
		} finally {
			if (this.flow === flow) this.flow = undefined;
		}
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

function toAuthEvent(event: EventRequest): AuthEvent {
	switch (event.type) {
		case "info": {
			const info: AuthEvent = { kind: "info", message: presentText(event.message) };
			if (event.links) info.links = event.links.map((l) => ({ ...l }));
			return info;
		}
		case "auth_url":
			return event.instructions
				? { kind: "auth_url", url: event.url, instructions: presentText(event.instructions) }
				: { kind: "auth_url", url: event.url };
		case "device_code": {
			const code: AuthEvent = {
				kind: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
			};
			if (event.expiresInSeconds) code.expiresInSeconds = event.expiresInSeconds;
			return code;
		}
		case "progress":
			return { kind: "progress", message: presentText(event.message) };
	}
}

function redact(text: string, secrets: string[]): string {
	let safe = text.slice(0, 300);
	for (const secret of secrets) if (secret.length >= 4) safe = safe.split(secret).join("[redacted]");
	return safe;
}
