import type { ContextUsageState } from "../store.ts";

interface ContextBarProps {
	usage?: ContextUsageState;
	onCompact: () => void;
	disabled?: boolean;
}

function formatTokens(num: number): string {
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(num);
}

export function ContextBar({ usage, onCompact, disabled = false }: ContextBarProps) {
	if (!usage) return null;

	const percent = Math.min(100, Math.max(0, usage.percent));
	const level = percent > 75 ? "high" : percent > 50 ? "medium" : "low";

	return (
		<div
			className="context-bar"
			title={`Contexto consumido: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${percent.toFixed(1)}%)\nEscribe /compact o pulsa el botón para compactar el contexto con Engram.`}
		>
			<div className="context-indicator">
				<span className="context-label">
					{formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)} ({percent.toFixed(0)}%)
				</span>
				<div className="context-meter" aria-hidden="true">
					<div
						className={`context-fill level-${level}`}
						style={{ width: `${Math.max(4, percent)}%` }}
					/>
				</div>
			</div>
			<button
				type="button"
				className="compact-btn"
				disabled={disabled}
				onClick={onCompact}
				title="Compactar contexto (preserva memorias en Engram y aligera la sesión)"
			>
				<span className="compact-icon" aria-hidden="true">🗜️</span>
				<span className="compact-text">Compactar</span>
			</button>
		</div>
	);
}
