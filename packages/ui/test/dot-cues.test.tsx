import type { AgentState } from "@gentle-dot/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cueFor, DONE_CHIME_MIN_BUSY_MS, PET_LEVEL, REMINDER_MS, useDotCues } from "../src/dot/cues.ts";
import { SOUNDS_KEY } from "../src/dot/sounds.ts";

describe("cueFor", () => {
	it.each<[AgentState, AgentState, ReturnType<typeof cueFor>]>([
		["working", "idle", "done"],
		["thinking", "idle", "done"],
		["needs_you", "idle", undefined],
		["starting", "idle", undefined],
		["idle", "thinking", undefined],
		["thinking", "working", undefined],
		["working", "needs_you", "ask"],
		["idle", "needs_you", "ask"],
		["working", "error", "error"],
		["idle", "idle", undefined],
	])("%s -> %s gives %s", (prev, next, cue) => {
		expect(cueFor(prev, next)).toBe(cue);
	});

	it("maps every agent state to a pet level", () => {
		expect(PET_LEVEL).toEqual({
			idle: 0,
			thinking: 1,
			working: 2,
			needs_you: 3,
			starting: 4,
			restarting: 4,
			error: 4,
		});
	});
});

function fakeAudio() {
	const oscillators: { frequency: number }[] = [];
	const param = () => ({
		value: 0,
		setValueAtTime: vi.fn(),
		linearRampToValueAtTime: vi.fn(),
		exponentialRampToValueAtTime: vi.fn(),
	});
	const context = {
		currentTime: 0,
		state: "running",
		destination: {},
		resume: vi.fn(async () => {}),
		createOscillator: vi.fn(() => {
			const frequency = param();
			const osc = {
				type: "sine",
				frequency,
				connect: vi.fn(),
				start: vi.fn(() => oscillators.push({ frequency: frequency.value })),
				stop: vi.fn(),
			};
			return osc;
		}),
		createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
	};
	return { context: context as unknown as AudioContext, oscillators };
}

describe("useDotCues", () => {
	let now = 0;
	let audio: ReturnType<typeof fakeAudio>;

	beforeEach(() => {
		vi.useFakeTimers();
		now = 0;
		audio = fakeAudio();
		window.localStorage.removeItem(SOUNDS_KEY);
	});
	afterEach(() => vi.useRealTimers());

	function setup(initial: AgentState) {
		return renderHook(({ state }) => useDotCues(state, { now: () => now, audio: () => audio.context }), {
			initialProps: { state: initial },
		});
	}

	it("reports the done cue and chimes after a long task", () => {
		const view = setup("idle");
		view.rerender({ state: "working" });
		now += DONE_CHIME_MIN_BUSY_MS;
		view.rerender({ state: "idle" });
		expect(view.result.current.cue).toEqual({ kind: "done", id: 1 });
		expect(audio.oscillators.length).toBeGreaterThan(0);
	});

	it("shows the done cue but stays silent after a short reply", () => {
		const view = setup("idle");
		view.rerender({ state: "thinking" });
		now += DONE_CHIME_MIN_BUSY_MS - 1;
		view.rerender({ state: "idle" });
		expect(view.result.current.cue?.kind).toBe("done");
		expect(audio.oscillators).toHaveLength(0);
	});

	it("counts a task from its first busy state across thinking and working", () => {
		const view = setup("idle");
		view.rerender({ state: "thinking" });
		now += DONE_CHIME_MIN_BUSY_MS / 2;
		view.rerender({ state: "working" });
		now += DONE_CHIME_MIN_BUSY_MS / 2;
		view.rerender({ state: "idle" });
		expect(audio.oscillators.length).toBeGreaterThan(0);
	});

	it("asks once, then reminds once while the question stays open", () => {
		const view = setup("working");
		view.rerender({ state: "needs_you" });
		const asked = audio.oscillators.length;
		expect(asked).toBeGreaterThan(0);
		expect(view.result.current.cue?.kind).toBe("ask");
		act(() => vi.advanceTimersByTime(REMINDER_MS));
		expect(audio.oscillators).toHaveLength(asked * 2);
		act(() => vi.advanceTimersByTime(REMINDER_MS * 3));
		expect(audio.oscillators).toHaveLength(asked * 2);
	});

	it("drops the reminder once the user answers", () => {
		const view = setup("working");
		view.rerender({ state: "needs_you" });
		const asked = audio.oscillators.length;
		view.rerender({ state: "working" });
		act(() => vi.advanceTimersByTime(REMINDER_MS * 2));
		expect(audio.oscillators).toHaveLength(asked);
	});

	it("reports and sounds the error cue", () => {
		const view = setup("working");
		view.rerender({ state: "error" });
		expect(view.result.current.cue).toEqual({ kind: "error", id: 1 });
		expect(audio.oscillators.length).toBeGreaterThan(0);
	});

	it("stays silent when sounds are off, but still reports cues", () => {
		window.localStorage.setItem(SOUNDS_KEY, "off");
		const view = setup("working");
		view.rerender({ state: "needs_you" });
		act(() => vi.advanceTimersByTime(REMINDER_MS));
		expect(view.result.current.cue?.kind).toBe("ask");
		expect(audio.oscillators).toHaveLength(0);
	});

	it("reports nothing on the first render or an unchanged state", () => {
		const view = setup("idle");
		view.rerender({ state: "idle" });
		expect(view.result.current.cue).toBeUndefined();
		expect(audio.oscillators).toHaveLength(0);
	});
});
