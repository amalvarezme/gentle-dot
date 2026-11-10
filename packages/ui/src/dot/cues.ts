import type { AgentState } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DotCue, playCue, soundsEnabled } from "./sounds.ts";

/** The robot state machine's `state` input for each agent state (see assets/robot.riv). */
export const PET_LEVEL: Record<AgentState, number> = {
	idle: 0,
	thinking: 1,
	working: 2,
	needs_you: 3,
	starting: 4,
	restarting: 4,
	error: 4,
};

/** A finished turn only chimes when it took at least this long; shorter replies just flash. */
export const DONE_CHIME_MIN_BUSY_MS = 8_000;

/** An unanswered question chimes once more after this long. */
export const REMINDER_MS = 30_000;

const BUSY: ReadonlySet<AgentState> = new Set(["thinking", "working"]);

/** The one-off cue a state change deserves, if any. */
export function cueFor(prev: AgentState, next: AgentState): DotCue | undefined {
	if (prev === next) return undefined;
	if (next === "needs_you") return "ask";
	if (next === "error") return "error";
	if (next === "idle" && BUSY.has(prev)) return "done";
	return undefined;
}

export interface CueEvent {
	kind: DotCue;
	/** Increases with every cue, so the same kind twice in a row still fires twice. */
	id: number;
}

interface CueOptions {
	now?: () => number;
	/** The audio context to play on; undefined when audio is unavailable. */
	audio?: () => AudioContext | undefined;
}

let sharedContext: AudioContext | undefined;
function defaultAudio(): AudioContext | undefined {
	if (sharedContext) return sharedContext;
	const Context = globalThis.AudioContext;
	if (typeof Context !== "function") return undefined;
	try {
		sharedContext = new Context();
	} catch {
		return undefined;
	}
	return sharedContext;
}

/**
 * Watches the agent state for moments worth a cue (a finished task, a question, an error),
 * returns the latest cue for the animation, and plays its sound: a finished task only after
 * DONE_CHIME_MIN_BUSY_MS of work, and an open question once more after REMINDER_MS.
 * `unlock` resumes audio from a user gesture, for webviews that start it suspended.
 */
export function useDotCues(state: AgentState, options: CueOptions = {}) {
	const now = options.now ?? Date.now;
	const audio = options.audio ?? defaultAudio;
	const nowRef = useRef(now);
	const audioRef = useRef(audio);
	nowRef.current = now;
	audioRef.current = audio;

	const prev = useRef(state);
	const busySince = useRef<number | undefined>(BUSY.has(state) ? now() : undefined);

	// The cue is derived during render, so the render that carries a new state also carries
	// its cue: the pet must fire the trigger before it sees the new level.
	const [tracked, setTracked] = useState<{ state: AgentState; cue: CueEvent | undefined }>({
		state,
		cue: undefined,
	});
	let cue = tracked.cue;
	if (tracked.state !== state) {
		const kind = cueFor(tracked.state, state);
		if (kind) cue = { kind, id: (tracked.cue?.id ?? 0) + 1 };
		setTracked({ state, cue });
	}

	const sound = useCallback((kind: DotCue) => {
		if (!soundsEnabled()) return;
		const context = audioRef.current();
		if (!context) return;
		if (context.state === "suspended") void context.resume().catch(() => {});
		playCue(context, kind);
	}, []);

	useEffect(() => {
		const before = prev.current;
		prev.current = state;
		if (before === state) return;

		const t = nowRef.current();
		const startedAt = busySince.current;
		if (BUSY.has(state)) {
			if (startedAt === undefined) busySince.current = t;
		} else {
			busySince.current = undefined;
		}

		const kind = cueFor(before, state);
		if (!kind) return;
		if (kind !== "done" || (startedAt !== undefined && t - startedAt >= DONE_CHIME_MIN_BUSY_MS)) sound(kind);
		if (kind !== "ask") return;
		const reminder = setTimeout(() => sound("ask"), REMINDER_MS);
		return () => clearTimeout(reminder);
	}, [state, sound]);

	const unlock = useCallback(() => {
		const context = audioRef.current();
		if (context?.state === "suspended") void context.resume().catch(() => {});
	}, []);

	return { cue, unlock };
}
