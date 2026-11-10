import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageEntry } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { UsageLedger } from "../src/usage-ledger.ts";
import { tempDir } from "./helpers.ts";

let seq = 0;

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
	seq += 1;
	return {
		ts: `2026-11-09T00:00:${String(seq).padStart(2, "0")}.000Z`,
		provider: "nan",
		model: "fake-model",
		input: 10,
		output: 25,
		cacheRead: 1,
		cacheWrite: 3,
		totalTokens: 39,
		cost: 0.0123,
		durationMs: 100,
		...overrides,
	};
}

const FILE = "model-calls.jsonl";
const OLD = "model-calls.old.jsonl";
const lines = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as UsageEntry);

describe("UsageLedger", () => {
	it("appends entries as JSON lines and reads them back oldest to newest with correct totals", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir });
		ledger.append(entry({ model: "a", cost: 0.01 }));
		ledger.append(
			entry({
				model: "b",
				input: 100,
				output: 200,
				cacheRead: 10,
				cacheWrite: 20,
				totalTokens: 330,
				cost: 0.02,
			}),
		);
		const { entries, totals } = ledger.read();
		expect(entries.map((e) => e.model)).toEqual(["a", "b"]);
		expect(totals).toEqual({
			calls: 2,
			input: 110,
			output: 225,
			cacheRead: 11,
			cacheWrite: 23,
			totalTokens: 10 + 25 + 1 + 3 + 330,
			cost: 0.03,
		});
		expect(lines(join(dir, FILE))).toHaveLength(2);
	});

	it("returns at most `limit` of the newest entries while totals cover every entry", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir });
		for (let i = 0; i < 5; i += 1) ledger.append(entry({ model: `m${i}`, cost: i * 0.01 }));
		const { entries, totals } = ledger.read(2);
		expect(entries.map((e) => e.model)).toEqual(["m3", "m4"]);
		expect(totals.calls).toBe(5);
	});

	it("rotates the file to model-calls.old.jsonl when it grows past maxSizeBytes", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir, maxSizeBytes: 250 });
		ledger.append(entry({ model: "first" }));
		expect(existsSync(join(dir, OLD))).toBe(false);
		ledger.append(entry({ model: "second" }));
		ledger.append(entry({ model: "third" }));
		expect(existsSync(join(dir, OLD))).toBe(true);
		expect(lines(join(dir, OLD)).map((e) => e.model)).toEqual(["first", "second"]);
		expect(lines(join(dir, FILE)).map((e) => e.model)).toEqual(["third"]);
		expect(ledger.read().entries.map((e) => e.model)).toEqual(["third"]);
	});

	it("writes the file 0600 and the directory 0700, and repairs both when their mode differs", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		chmodSync(dir, 0o755);
		const ledger = new UsageLedger({ dir });
		ledger.append(entry());
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const file = join(dir, FILE);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// A stray wider mode is repaired on the next append.
		chmodSync(file, 0o644);
		ledger.append(entry());
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("keeps entries in the current file only for totals, ignoring the rotated .old file", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir, maxSizeBytes: 1 });
		ledger.append(entry({ input: 10, cost: 0.01 }));
		ledger.append(entry({ input: 20, cost: 0.02 }));
		const { entries, totals } = ledger.read();
		expect(entries).toHaveLength(1);
		expect(totals.calls).toBe(1);
		expect(totals.input).toBe(20);
	});

	it("skips malformed lines instead of failing the read", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir });
		writeFileSync(join(dir, FILE), `${JSON.stringify(entry({ model: "good" }))}\nnot json\n{"model":}\n\n`);
		const { entries, totals } = ledger.read();
		expect(entries.map((e) => e.model)).toEqual(["good"]);
		expect(totals.calls).toBe(1);
	});

	it("is a no-op when disabled", () => {
		const dir = tempDir();
		const ledger = new UsageLedger({ dir, disabled: true });
		ledger.append(entry());
		expect(existsSync(join(dir, FILE))).toBe(false);
		expect(ledger.read()).toEqual({
			entries: [],
			totals: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		});
	});

	it("reports failures through onError instead of throwing into the caller", () => {
		const dir = tempDir();
		// A directory where the ledger's file belongs makes every append fail.
		mkdirSync(join(dir, FILE));
		const errors: Error[] = [];
		const ledger = new UsageLedger({ dir, onError: (error) => errors.push(error) });
		expect(() => ledger.append(entry())).not.toThrow();
		expect(errors).toHaveLength(1);
		expect(ledger.read().entries).toEqual([]);
	});
});
