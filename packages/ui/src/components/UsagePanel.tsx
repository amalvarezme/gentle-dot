import type { UsageEntry } from "@gentle-dot/protocol";
import type { DotAction, UsageState } from "../store.ts";
import { formatTokens } from "./ContextBar.tsx";
import "./usage.css";

interface UsagePanelProps {
	usage: UsageState;
	dispatch: (action: DotAction) => void;
}

/** USD cost: more precision when the amounts are small. */
function formatCost(cost: number): string {
	return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Model-call duration: milliseconds under a second, seconds with one decimal after. */
function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The daemon's per-model-call ledger (S1), read only; the data comes from the `usage` payload. */
export function UsagePanel({ usage, dispatch }: UsagePanelProps) {
	const entries = usage.entries ?? [];
	const loading = !usage.loaded;
	return (
		<section className="accounts profiles usage" aria-label="Usage">
			<header className="profiles-header">
				<h2>Usage</h2>
				<button
					type="button"
					className="icon"
					aria-label="Close usage"
					onClick={() => dispatch({ type: "usage", open: false })}
				>
					×
				</button>
			</header>

			{loading ? <p className="muted">Loading…</p> : null}
			{!loading && entries.length === 0 ? <p className="muted">No model calls recorded yet.</p> : null}
			{!loading && usage.totals ? (
				// A group, not a fieldset: the totals are a summary line, not a form.
				// biome-ignore lint/a11y/useSemanticElements: a <fieldset> would drag form styling in
				<div className="usage-totals" role="group" aria-label="Usage totals">
					<span>
						{usage.totals.calls} {usage.totals.calls === 1 ? "call" : "calls"}
					</span>
					<span>{formatTokens(usage.totals.totalTokens)} tokens</span>
					<span>
						in {formatTokens(usage.totals.input)} · out {formatTokens(usage.totals.output)}
					</span>
					<span>cache read {formatTokens(usage.totals.cacheRead)}</span>
					<span className="usage-cost">{formatCost(usage.totals.cost)}</span>
				</div>
			) : null}
			{!loading && entries.length > 0 ? (
				<ul className="usage-list">
					{[...entries].reverse().map((entry) => (
						<UsageRow
							key={`${entry.ts}-${entry.provider}-${entry.model}-${entry.durationMs}-${entry.totalTokens}`}
							entry={entry}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}

function UsageRow({ entry }: { entry: UsageEntry }) {
	return (
		<li className={entry.errorMessage ? "usage-error" : undefined}>
			<div className="usage-row-main">
				<b>{`${entry.provider}/${entry.model}`}</b>
				{entry.thinkingLevel ? <span className="chip">{entry.thinkingLevel}</span> : null}
				<span className="usage-cost">{formatCost(entry.cost)}</span>
			</div>
			<p className="usage-row-meta">
				in {formatTokens(entry.input)} · out {formatTokens(entry.output)} · cache read{" "}
				{formatTokens(entry.cacheRead)} · {formatDuration(entry.durationMs)} ·{" "}
				<time dateTime={entry.ts}>{new Date(entry.ts).toLocaleTimeString()}</time>
			</p>
			{entry.errorMessage ? <p className="usage-row-problem">{entry.errorMessage}</p> : null}
		</li>
	);
}
