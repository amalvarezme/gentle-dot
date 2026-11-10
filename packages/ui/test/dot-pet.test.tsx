import type { AgentState } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CueEvent } from "../src/dot/cues.ts";

const h = vi.hoisted(() => ({
	supported: true,
	ready: true,
	props: [] as { level: number; cue: CueEvent | undefined }[],
}));

vi.mock("../src/components/PetDot.tsx", async () => {
	const { useEffect } = await import("react");
	return {
		supportsPet: () => h.supported,
		PetDot: (props: { level: number; cue: CueEvent | undefined; onReady: (ready: boolean) => void }) => {
			h.props.push({ level: props.level, cue: props.cue });
			const { onReady } = props;
			useEffect(() => onReady(h.ready), [onReady]);
			return <span className="dot-pet" />;
		},
	};
});

const { DotSurface } = await import("../src/components/DotSurface.tsx");

function dot(agentState: AgentState) {
	return <DotSurface agentState={agentState} connected toggle={vi.fn()} startDrag={vi.fn()} />;
}

describe("DotSurface with the robot pet", () => {
	beforeEach(() => {
		h.supported = true;
		h.ready = true;
		h.props = [];
	});
	afterEach(() => vi.restoreAllMocks());

	it("swaps the still robot for the animated one once it loads", () => {
		const { container } = render(dot("idle"));
		expect(container.querySelector(".dot-disc > .dot-pet")).not.toBeNull();
		expect(container.querySelector(".dot-pet-still")).toBeNull();
		expect(screen.getByRole("button", { name: "Gentle Dot: ready" })).toBeInTheDocument();
	});

	it("keeps the still robot, never the rose or logo, when the animation fails to load", () => {
		h.ready = false;
		const { container } = render(dot("idle"));
		expect(container.querySelector(".dot-pet-still")).not.toBeNull();
		expect(container.querySelector(".rose, .dot-logo")).toBeNull();
	});

	it("keeps the still robot when animation is not supported", () => {
		h.supported = false;
		const { container } = render(dot("idle"));
		expect(container.querySelector(".dot-pet")).toBeNull();
		expect(container.querySelector(".dot-pet-still")).not.toBeNull();
	});

	it("opens the panel when the robot is clicked", () => {
		const toggle = vi.fn();
		render(<DotSurface agentState="idle" connected toggle={toggle} startDrag={vi.fn()} />);
		const button = screen.getByRole("button", { name: "Gentle Dot: ready" });
		fireEvent.pointerDown(button, { clientX: 5, clientY: 5, button: 0 });
		fireEvent.pointerUp(button, { clientX: 5, clientY: 5, button: 0 });
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("drives the pet's level and fires the done cue when a task ends", () => {
		const view = render(dot("idle"));
		view.rerender(dot("working"));
		expect(h.props.at(-1)?.level).toBe(2);
		act(() => view.rerender(dot("idle")));
		expect(h.props.at(-1)).toEqual({ level: 0, cue: { kind: "done", id: 1 } });
	});

	it("never hands the pet a new level before its cue", () => {
		const view = render(dot("idle"));
		view.rerender(dot("working"));
		const from = h.props.length;
		act(() => view.rerender(dot("idle")));
		act(() => view.rerender(dot("needs_you")));
		for (const props of h.props.slice(from)) {
			if (props.level === 0) expect(props.cue?.kind).toBe("done");
			if (props.level === 3) expect(props.cue?.kind).toBe("ask");
		}
	});

	it("shows the pet offline while disconnected", () => {
		render(<DotSurface agentState="working" connected={false} toggle={vi.fn()} startDrag={vi.fn()} />);
		expect(h.props.at(-1)?.level).toBe(4);
	});
});
