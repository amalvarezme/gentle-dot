import { join } from "node:path";
import type { ServerMessage, UsageEntry } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function setup() {
	const dataDir = tempDir();
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env },
		agentHome: join(dataDir, "agent"),
		profilesImportPath: join(tempDir(), "profiles.json"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
	});
	daemons.push(d);
	return { d, dataDir };
}

async function connect(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	function find<T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
	) {
		return waitFor(() =>
			messages.find(
				(m): m is Extract<ServerMessage, { type: T }> =>
					m.type === type && where(m as Extract<ServerMessage, { type: T }>),
			),
		);
	}
	return { messages, send, find };
}

describe("the per-model-call usage ledger (S1)", () => {
	it("answers usage_list with the calls the fake agent reported, with matching totals", async () => {
		const { d } = await setup();
		const client = await connect(d);
		client.send({ type: "send", text: "hello ledger" });
		await client.find("message_done");
		client.send({ type: "usage_list" });
		const usage = await client.find("usage", (m) => m.entries.length > 0);
		const call = usage.entries.at(-1) as UsageEntry;
		// S2: provider/model as the engine message reports them (a bridge-proxied call).
		expect(call.provider).toBe("nan");
		expect(call.model).toBe("fake-model");
		expect(call.thinkingLevel).toBe("medium");
		expect(call).toMatchObject({ input: 10, output: 25, cacheRead: 0, cacheWrite: 3, totalTokens: 38 });
		expect(call.cost).toBeCloseTo(0.0123);
		expect(call.durationMs).toBeGreaterThanOrEqual(0);
		expect(call.stopReason).toBe("stop");
		expect(typeof call.ts).toBe("string");
		expect(usage.totals.calls).toBeGreaterThanOrEqual(1);
		expect(usage.totals.input).toBeGreaterThanOrEqual(10);
		expect(usage.totals.output).toBeGreaterThanOrEqual(25);
		expect(usage.totals.cost).toBeGreaterThan(0);
	});

	it("pushes a usage snapshot to a client that connects, without being asked", async () => {
		const { d } = await setup();
		const first = await connect(d);
		first.send({ type: "send", text: "snapshot" });
		await first.find("message_done");
		// A window that does nothing after hello still gets the ledger's state.
		const second = await connect(d);
		const usage = await second.find("usage", (m) => m.entries.length > 0);
		expect(usage.totals.calls).toBeGreaterThanOrEqual(1);
		expect(second.messages.some((m) => (m as { type: string }).type === "usage_list")).toBe(false);
	});

	it("keeps the ledger on disk at <dataDir>/usage/model-calls.jsonl", async () => {
		const { d, dataDir } = await setup();
		const client = await connect(d);
		client.send({ type: "send", text: "persist" });
		await client.find("message_done");
		client.send({ type: "usage_list" });
		const usage = await client.find("usage", (m) => m.entries.length > 0);
		expect(usage.entries.length).toBeGreaterThanOrEqual(1);
		const { existsSync, readFileSync } = await import("node:fs");
		const file = join(dataDir, "usage", "model-calls.jsonl");
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as UsageEntry);
		expect(lines.some((e) => e.model === "fake-model")).toBe(true);
	});
});
