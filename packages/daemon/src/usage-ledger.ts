/**
 * The daemon's per-model-call usage ledger (S1): one JSON line per completed assistant message,
 * modeled on the @vanillagreen/pi-claude-bridge call log (per-call in/out/cache fields as JSON
 * lines) with the hardening the bridge lacks — 0600/0700 permissions with repair, size rotation
 * to a `.old` file, and failures that never reach the caller.
 *
 * The file lives in its own `<dataDir>/usage/` directory, never under `sessions/`: the session
 * directory belongs to the engine (rotated, exported, read as the engine's user) and the ledger
 * is the daemon's own record.
 */
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { UsageEntry, UsageTotals } from "@gentle-dot/protocol";

export interface UsageLedgerOptions {
	dir: string;
	/** Rotate model-calls.jsonl to model-calls.old.jsonl once it grows past this. Default 5 MB. */
	maxSizeBytes?: number;
	/** Set by the caller from `GENTLE_DOT_USAGE_LEDGER=0`; a disabled ledger writes and reads nothing. */
	disabled?: boolean;
	/** Observed append failures; a ledger never throws into the bridge. */
	onError?: (error: Error) => void;
}

const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const EMPTY_TOTALS: UsageTotals = {
	calls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

export class UsageLedger {
	private readonly dir: string;
	private readonly file: string;
	private readonly oldFile: string;
	private readonly maxSizeBytes: number;
	private readonly disabled: boolean;
	private readonly onError?: (error: Error) => void;

	constructor(options: UsageLedgerOptions) {
		this.dir = options.dir;
		this.file = join(this.dir, "model-calls.jsonl");
		this.oldFile = join(this.dir, "model-calls.old.jsonl");
		this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
		this.disabled = options.disabled ?? false;
		this.onError = options.onError;
	}

	/** Appends one call record; any failure is reported through `onError` and swallowed. */
	append(entry: UsageEntry): void {
		if (this.disabled) return;
		try {
			this.ensureDir();
			this.rotateIfNeeded();
			this.repairFileMode();
			// `mode` applies only when the file is created; existing files keep their mode.
			appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch (error) {
			this.onError?.(error as Error);
		}
	}

	/**
	 * The at most `limit` newest entries (oldest to newest) from the current file, and the totals
	 * over every entry in it. Malformed lines are skipped.
	 */
	read(limit = 200): { entries: UsageEntry[]; totals: UsageTotals } {
		if (this.disabled) return { entries: [], totals: { ...EMPTY_TOTALS } };
		const entries: UsageEntry[] = [];
		const totals: UsageTotals = { ...EMPTY_TOTALS };
		try {
			for (const line of readFileSync(this.file, "utf8").split("\n")) {
				if (!line) continue;
				let parsed: UsageEntry;
				try {
					parsed = JSON.parse(line) as UsageEntry;
				} catch {
					continue;
				}
				entries.push(parsed);
				totals.calls += 1;
				totals.input += parsed.input ?? 0;
				totals.output += parsed.output ?? 0;
				totals.cacheRead += parsed.cacheRead ?? 0;
				totals.cacheWrite += parsed.cacheWrite ?? 0;
				totals.totalTokens += parsed.totalTokens ?? 0;
				totals.cost += parsed.cost ?? 0;
			}
		} catch {
			// No file yet: an empty ledger.
			return { entries: [], totals: { ...EMPTY_TOTALS } };
		}
		return { entries: entries.slice(-limit), totals };
	}

	private ensureDir(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		if ((statSync(this.dir).mode & 0o777) !== 0o700) chmodSync(this.dir, 0o700);
	}

	private rotateIfNeeded(): void {
		if (!existsSync(this.file) || statSync(this.file).size <= this.maxSizeBytes) return;
		renameSync(this.file, this.oldFile);
	}

	private repairFileMode(): void {
		if (!existsSync(this.file)) return;
		if ((statSync(this.file).mode & 0o777) !== 0o600) chmodSync(this.file, 0o600);
	}
}
