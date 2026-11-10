import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { AuthManager } from "../src/auth.ts";
import { ClaudeCodeAccount, claudeCodeExecutable } from "../src/claude-code-account.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { tempDir, waitFor } from "./helpers.ts";

/** A stand-in for the `claude` CLI: `auth status` reads a file, `auth login` follows a script. */
function fakeClaude(dir: string, options: { loggedIn: boolean; login?: "browser" | "code" | "fail" }) {
	const exe = join(dir, "claude");
	writeFileSync(join(dir, "logged-in"), options.loggedIn ? "true" : "false");
	writeFileSync(
		exe,
		`#!/bin/sh
dir="$(dirname "$0")"
if [ "$1 $2" = "auth status" ]; then
  printf '{"loggedIn": %s, "authMethod": "claude.ai"}\\n' "$(cat "$dir/logged-in")"
  exit 0
fi
if [ "$1 $2 $3" = "auth login --claudeai" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1"
  case "${options.login ?? "browser"}" in
    browser) sleep 0.2; echo true > "$dir/logged-in"; echo "Login successful."; exit 0 ;;
    code) printf "Paste code here if prompted > "; read code; [ "$code" = "good-code" ] || exit 3; echo true > "$dir/logged-in"; exit 0 ;;
    fail) echo "OAuth error: denied" >&2; exit 1 ;;
  esac
fi
exit 2
`,
	);
	chmodSync(exe, 0o755);
	return exe;
}

function interaction(answer?: string) {
	const events: { type: string; url?: string }[] = [];
	const prompts: { type: string; message: string }[] = [];
	return {
		events,
		prompts,
		value: {
			signal: new AbortController().signal,
			notify: (event: { type: string; url?: string }) => events.push(event),
			prompt: (request: { type: string; message: string }) => {
				prompts.push(request);
				return answer === undefined ? new Promise<string>(() => {}) : Promise.resolve(answer);
			},
		},
	};
}

describe("claudeCodeExecutable", () => {
	it("is undefined when the claude-bridge is not set up in the assistant's home", () => {
		expect(claudeCodeExecutable(tempDir())).toBeUndefined();
	});

	it("uses the bridge's configured Claude Code, or `claude` when none is set", () => {
		const home = tempDir();
		writeFileSync(join(home, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max" } }));
		expect(claudeCodeExecutable(home)).toBe("claude");
		writeFileSync(
			join(home, "claude-bridge.json"),
			JSON.stringify({ provider: { pathToClaudeCodeExecutable: "/opt/claude-wrapper" } }),
		);
		expect(claudeCodeExecutable(home)).toBe("/opt/claude-wrapper");
	});
});

describe("ClaudeCodeAccount", () => {
	it("reports whether Claude Code is signed in", async () => {
		const dir = tempDir();
		expect(await new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: true })).signedIn()).toBe(true);
		const other = tempDir();
		expect(await new ClaudeCodeAccount(fakeClaude(other, { loggedIn: false })).signedIn()).toBe(false);
	});

	it("is not signed in when Claude Code is missing", async () => {
		expect(await new ClaudeCodeAccount(join(tempDir(), "missing")).signedIn()).toBe(false);
	});

	it("signs in through the browser: shows the sign-in link and finishes when Claude Code does", async () => {
		const dir = tempDir();
		const account = new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: false, login: "browser" }));
		const flow = interaction();
		await account.login(flow.value as never);
		expect(flow.events[0]).toMatchObject({
			type: "auth_url",
			url: "https://claude.com/cai/oauth/authorize?code=true&x=1",
		});
		expect(await account.signedIn()).toBe(true);
	});

	it("passes the code the user pastes when Claude Code asks for one", async () => {
		const dir = tempDir();
		const account = new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: false, login: "code" }));
		const flow = interaction("good-code");
		await account.login(flow.value as never);
		expect(flow.prompts[0]).toMatchObject({ type: "manual_code" });
		expect(await account.signedIn()).toBe(true);
	});

	it("fails when Claude Code's sign-in fails", async () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const account = new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: false, login: "fail" }));
		await expect(account.login(interaction().value as never)).rejects.toThrow(/Claude Code sign-in failed/);
		expect(await account.signedIn()).toBe(false);
	});
});

describe("Accounts: Claude through Claude Code", () => {
	const manager = (claudeCode?: ClaudeCodeAccount) =>
		new AuthManager({
			runtime: async () => fakeAuthRuntime().runtime,
			...(claudeCode ? { claudeCode } : {}),
		});

	it("lists Claude (Claude Code) with its sign-in status only when the claude-bridge is set up", async () => {
		expect((await manager().providers()).some((p) => p.id === "claude-bridge")).toBe(false);
		const dir = tempDir();
		const providers = await manager(new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: true }))).providers();
		expect(providers.find((p) => p.id === "claude-bridge")).toEqual({
			id: "claude-bridge",
			name: "Claude (Claude Code)",
			methods: ["oauth"],
			oauthName: "Claude (via Claude Code)",
			configured: true,
			source: "claude-code",
		});
	});

	it("signs in with Claude Code's own sign-in and reports it done", async () => {
		const dir = tempDir();
		const auth = manager(new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: false, login: "browser" })));
		const emitted: ServerPayload[] = [];
		expect(auth.start({}, "claude-bridge", "oauth", (p) => emitted.push(p))).toBeUndefined();
		await waitFor(() => emitted.some((p) => p.type === "auth_done"));
		expect(emitted.find((p) => p.type === "auth_event")).toMatchObject({ event: { kind: "auth_url" } });
		expect(emitted.find((p) => p.type === "auth_done")).toMatchObject({
			providerId: "claude-bridge",
			ok: true,
		});
		expect((await auth.providers()).find((p) => p.id === "claude-bridge")?.configured).toBe(true);
	});

	it("never signs Claude Code out: it says to use the terminal", async () => {
		const dir = tempDir();
		const auth = manager(new ClaudeCodeAccount(fakeClaude(dir, { loggedIn: true })));
		expect(await auth.logout("claude-bridge")).toMatchObject({ code: "auth_unsupported" });
		expect(await new ClaudeCodeAccount(join(dir, "claude")).signedIn()).toBe(true);
	});
});
