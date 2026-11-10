import type { AgentState } from "@gentle-dot/protocol";
import { useCallback, useRef, useState } from "react";
import robotStillUrl from "../assets/robot-still.png";
import { PET_LEVEL, useDotCues } from "../dot/cues.ts";
import { isWindows } from "../shortcut.ts";
import { PetDot, supportsPet } from "./PetDot.tsx";

const LABELS: Record<AgentState, string> = {
	starting: "starting",
	idle: "ready",
	thinking: "thinking",
	working: "working",
	needs_you: "needs your answer",
	restarting: "restarting",
	error: "unavailable",
};

const DRAG_THRESHOLD_PX = 3;

interface DotSurfaceProps {
	agentState: AgentState;
	connected: boolean;
	/** The assistant controls the Mac (S24.6); it shows over every other state. */
	inControl?: boolean;
	/** Yolo mode is on (S24.9): risky actions run without asking, so the rim says so. */
	yolo?: boolean;
	toggle: () => void;
	startDrag: () => void;
}

/**
 * The collapsed, always-on-top robot pet in its black circle: animated when the webview allows it,
 * a still robot otherwise. A click opens the panel; a drag moves the window.
 */
export function DotSurface({
	agentState,
	connected,
	inControl = false,
	yolo = false,
	toggle,
	startDrag,
}: DotSurfaceProps) {
	const press = useRef<{ x: number; y: number; dragging: boolean } | undefined>(undefined);
	const state = connected ? agentState : "restarting";
	const label = inControl ? `controlling your ${isWindows() ? "PC" : "Mac"}` : LABELS[state];
	const [pet] = useState(supportsPet);
	const [petReady, setPetReady] = useState(false);
	const onPetReady = useCallback((ready: boolean) => setPetReady(ready), []);
	const { cue, unlock } = useDotCues(state);

	return (
		<button
			type="button"
			className={`dot dot-${state}${inControl ? " dot-in_control" : ""}${yolo ? " dot-yolo" : ""}`}
			aria-label={`Gentle Dot: ${label}${yolo ? ", yolo mode on" : ""}`}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				unlock();
				press.current = { x: event.clientX, y: event.clientY, dragging: false };
			}}
			onPointerMove={(event) => {
				const p = press.current;
				if (!p || p.dragging) return;
				if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > DRAG_THRESHOLD_PX) {
					p.dragging = true;
					startDrag();
				}
			}}
			onPointerUp={() => {
				const p = press.current;
				press.current = undefined;
				if (p && !p.dragging) toggle();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			}}
		>
			<span className="dot-disc" aria-hidden="true">
				{pet ? <PetDot level={PET_LEVEL[state]} cue={cue} onReady={onPetReady} /> : null}
				{petReady ? null : <img src={robotStillUrl} alt="" className="dot-pet-still" />}
			</span>
			{state === "needs_you" ? (
				<span className="dot-badge" aria-hidden="true">
					!
				</span>
			) : null}
		</button>
	);
}
