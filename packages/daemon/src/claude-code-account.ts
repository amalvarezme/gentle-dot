import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInteraction } from "./auth.ts";

/** The provider id the claude-bridge registers its models under, and its Accounts entry. */
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";

const STATUS_TIMEOUT_MS = 10_000;
const URL_PATTERN = /https:\/\/\S+/;
const CODE_PROMPT = /paste code here/i;

/**
 * The Claude Code the claude-bridge runs, from `claude-bridge.json` in the assistant's home:
 * its `provider.pathToClaudeCodeExecutable`, or `claude` when none is set. Undefined when the
 * bridge is not set up, so Accounts offers Claude only where the bridge can use it.
 */
export function claudeCodeExecutable(agentHome: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(join(agentHome, "claude-bridge.json"), "utf8");
	} catch {
		return undefined;
	}
	try {
		const config = JSON.parse(text) as { provider?: { pathToClaudeCodeExecutable?: unknown } };
		const path = config.provider?.pathToClaudeCodeExecutable;
		return typeof path === "string" && path.trim() ? path : "claude";
	} catch {
		return "claude";
	}
}

/**
 * The user's own Claude Code sign-in, which the claude-bridge uses. The assistant reads its status
 * and can start Claude Code's official sign-in; signing out stays in the user's terminal, because
 * it would sign Claude Code out everywhere.
 */
export class ClaudeCodeAccount {
	private readonly executable: string;

	constructor(executable: string) {
		this.executable = executable;
	}

	signedIn(): Promise<boolean> {
		return new Promise((resolve) => {
			execFile(
				this.executable,
				["auth", "status", "--json"],
				{ timeout: STATUS_TIMEOUT_MS },
				// A missing or failing Claude Code prints no status: not signed in.
				(_error, stdout) => {
					try {
						resolve((JSON.parse(String(stdout)) as { loggedIn?: unknown }).loggedIn === true);
					} catch {
						resolve(false);
					}
				},
			);
		});
	}

	/** Runs `claude auth login --claudeai`: Claude Code opens the browser; a pasted code is passed on. */
	login(interaction: AuthInteraction): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.executable, ["auth", "login", "--claudeai"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let shownUrl = false;
			let asked = false;
			const abort = () => child.kill();
			interaction.signal?.addEventListener("abort", abort, { once: true });
			const onOutput = (chunk: Buffer) => {
				output += String(chunk);
				const url = output.match(URL_PATTERN)?.[0];
				if (url && !shownUrl) {
					shownUrl = true;
					interaction.notify({
						type: "auth_url",
						url,
						instructions: "Finish signing in to Claude in your browser.",
					});
				}
				if (!asked && CODE_PROMPT.test(output)) {
					asked = true;
					interaction.prompt({ type: "manual_code", message: "If Claude shows a code, paste it here" }).then(
						(code) => child.stdin.write(`${code.trim()}\n`),
						() => {},
					);
				}
			};
			child.stdout.on("data", onOutput);
			child.stderr.on("data", onOutput);
			child.on("error", (error) => {
				interaction.signal?.removeEventListener("abort", abort);
				reject(new Error(`Claude Code could not start: ${error.message}`));
			});
			child.on("close", (code) => {
				interaction.signal?.removeEventListener("abort", abort);
				if (code === 0) resolve();
				else reject(new Error(`Claude Code sign-in failed (exit ${code ?? "signal"})`));
			});
		});
	}
}
