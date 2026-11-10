import wasmUrl from "@rive-app/canvas-lite/rive.wasm?url";
import { Alignment, Fit, Layout, RuntimeLoader, useRive } from "@rive-app/react-canvas-lite";
import { useEffect, useRef } from "react";
import robotUrl from "../assets/robot.riv?url";
import type { CueEvent } from "../dot/cues.ts";

// Load the runtime from the app bundle, never from Rive's CDN: no CDN fallback either,
// so a failed load shows the rose instead.
RuntimeLoader.setWasmUrl(wasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

const STATE_MACHINE = "Dot";
const LAYOUT = new Layout({ fit: Fit.Contain, alignment: Alignment.Center });
/**
 * A trigger that lands while the state machine blends between states is dropped, so a
 * cue fires first and the new level follows once the cue's animation has taken over.
 */
const LEVEL_AFTER_CUE_MS = 120;

/** Whether this webview should animate the robot pet: motion allowed and WebAssembly available. */
export function supportsPet(): boolean {
	if (typeof window.matchMedia !== "function" || typeof WebAssembly !== "object") return false;
	return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface PetDotProps {
	/** The state machine's `state` input (PET_LEVEL). */
	level: number;
	/** The latest one-off cue; a new `id` fires its trigger once. */
	cue: CueEvent | undefined;
	/** Called with true once the animation shows, or false when it cannot load. */
	onReady: (ready: boolean) => void;
}

/** The Dot's animated robot pet (assets/robot.riv), drawn on a canvas that fills the disc. */
export function PetDot({ level, cue, onReady }: PetDotProps) {
	const { rive, RiveComponent } = useRive({
		src: robotUrl,
		stateMachine: STATE_MACHINE,
		autoplay: true,
		layout: LAYOUT,
		onLoad: () => onReady(true),
		onLoadError: () => onReady(false),
	});
	// Cues from before the pet mounted are history, not news.
	const firedCue = useRef(cue?.id ?? 0);

	useEffect(() => {
		if (!rive) return;
		const inputs = rive.stateMachineInputs(STATE_MACHINE) ?? [];
		const setLevel = () => {
			const input = inputs.find((i) => i.name === "state");
			if (input) input.value = level;
		};
		if (cue && cue.id !== firedCue.current) {
			firedCue.current = cue.id;
			const trigger = inputs.find((i) => i.name === cue.kind);
			if (trigger) {
				trigger.fire();
				const timer = setTimeout(setLevel, LEVEL_AFTER_CUE_MS);
				return () => clearTimeout(timer);
			}
		}
		setLevel();
	}, [rive, level, cue]);

	return (
		<span className="dot-pet" aria-hidden="true">
			<RiveComponent />
		</span>
	);
}
