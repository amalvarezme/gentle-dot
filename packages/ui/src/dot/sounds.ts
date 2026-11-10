/** Short synthesized cues for the Dot: no audio files, just oscillators with a soft envelope. */

export type DotCue = "done" | "ask" | "error";

/** Set this localStorage key to "off" to silence the Dot; visual cues keep playing. */
export const SOUNDS_KEY = "gentle-dot.dot-sounds";

interface Note {
	/** Start frequency in Hz. */
	freq: number;
	/** Glide to this frequency by the end of the note. */
	to?: number;
	/** Start, in seconds after the cue begins. */
	at: number;
	/** Length in seconds. */
	dur: number;
	type?: OscillatorType;
}

const CUES: Record<DotCue, { gain: number; notes: Note[] }> = {
	// Two rising notes: a satisfied "task complete".
	done: {
		gain: 0.12,
		notes: [
			{ freq: 659.25, at: 0, dur: 0.14 },
			{ freq: 987.77, at: 0.12, dur: 0.3 },
		],
	},
	// A question: two beeps, the second higher and held.
	ask: {
		gain: 0.1,
		notes: [
			{ freq: 880, at: 0, dur: 0.1, type: "triangle" },
			{ freq: 1174.66, at: 0.16, dur: 0.32, type: "triangle" },
		],
	},
	// A low falling buzz.
	error: {
		gain: 0.06,
		notes: [{ freq: 220, to: 146.83, at: 0, dur: 0.35, type: "sawtooth" }],
	},
};

export function soundsEnabled(): boolean {
	try {
		return window.localStorage.getItem(SOUNDS_KEY) !== "off";
	} catch {
		return true;
	}
}

/** Schedules the cue's notes on `context`; returns immediately. */
export function playCue(context: AudioContext, cue: DotCue): void {
	const { gain, notes } = CUES[cue];
	const start = context.currentTime + 0.01;
	for (const note of notes) {
		const t = start + note.at;
		const osc = context.createOscillator();
		const env = context.createGain();
		osc.type = note.type ?? "sine";
		osc.frequency.value = note.freq;
		osc.frequency.setValueAtTime(note.freq, t);
		if (note.to !== undefined) osc.frequency.exponentialRampToValueAtTime(note.to, t + note.dur);
		env.gain.setValueAtTime(0, t);
		env.gain.linearRampToValueAtTime(gain, t + 0.012);
		env.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
		osc.connect(env);
		env.connect(context.destination);
		osc.start(t);
		osc.stop(t + note.dur + 0.02);
	}
}
