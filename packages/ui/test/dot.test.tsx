import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@gentle-dot/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DotSurface } from "../src/components/DotSurface.tsx";

function setup(agentState: AgentState = "idle", connected = true) {
	const toggle = vi.fn();
	const startDrag = vi.fn();
	render(<DotSurface agentState={agentState} connected={connected} toggle={toggle} startDrag={startDrag} />);
	return { toggle, startDrag, dot: screen.getByRole("button") };
}

describe("DotSurface", () => {
	it("opens the panel on click", () => {
		const { toggle, startDrag, dot } = setup();
		fireEvent.pointerDown(dot, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerUp(dot, { clientX: 11, clientY: 10, button: 0 });
		expect(toggle).toHaveBeenCalledTimes(1);
		expect(startDrag).not.toHaveBeenCalled();
	});

	it("drags instead of opening when the pointer moves", () => {
		const { toggle, startDrag, dot } = setup();
		fireEvent.pointerDown(dot, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerMove(dot, { clientX: 20, clientY: 18, button: 0 });
		fireEvent.pointerUp(dot, { clientX: 20, clientY: 18, button: 0 });
		expect(startDrag).toHaveBeenCalledTimes(1);
		expect(toggle).not.toHaveBeenCalled();
	});

	it("opens from the keyboard", () => {
		const { toggle, dot } = setup();
		fireEvent.keyDown(dot, { key: "Enter" });
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("shows the state and a badge when the assistant needs the user", () => {
		const { dot } = setup("needs_you");
		expect(dot).toHaveAccessibleName("Gentle Dot: needs your answer");
		expect(dot).toHaveClass("dot-needs_you");
		// The badge sits on the circle's edge, outside the disc.
		expect(dot.querySelector(":scope > .dot-badge")).toHaveTextContent("!");
	});

	it("is the robot pet inside a black disc, with no rose or UNAL logo", () => {
		const { dot } = setup();
		expect(dot.querySelector(".dot-disc")).toHaveAttribute("aria-hidden", "true");
		// Without an animation runtime (as here), the robot shows as a still image.
		const still = dot.querySelector(":scope > .dot-disc > img.dot-pet-still");
		expect(still).not.toBeNull();
		expect(still?.getAttribute("src")).toMatch(/robot-still/);
		expect(dot.querySelector(".rose")).toBeNull();
		expect(dot.querySelector(".dot-logo, .dot-logo-badge")).toBeNull();
	});

	it("keeps the Dot surface the same size as its window", () => {
		const read = (relative: string) =>
			readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
		const rule = read("../src/styles.css").match(/\n\.dot \{([^}]*)\}/)?.[1] ?? "";
		const window = read("../../../apps/desktop/src-tauri/src/shell.rs").match(
			/const DOT_SIZE: \(f64, f64\) = \(([\d.]+), ([\d.]+)\)/,
		);
		expect(window?.slice(1).map(Number)).toEqual([72, 72]);
		expect(rule).toMatch(/\twidth: 72px;/);
		expect(rule).toMatch(/\theight: 72px;/);
	});

	it.each<[AgentState, string]>([
		["starting", "starting"],
		["idle", "ready"],
		["thinking", "thinking"],
		["working", "working"],
		["needs_you", "needs your answer"],
		["restarting", "restarting"],
		["error", "unavailable"],
	])("renders %s as the robot pet", (state, label) => {
		const { dot } = setup(state);
		expect(dot).toHaveAccessibleName(`Gentle Dot: ${label}`);
		expect(dot).toHaveClass(`dot-${state}`);
		expect(dot.querySelector(".dot-pet-still")).not.toBeNull();
		if (state !== "needs_you") expect(screen.queryByText("!")).toBeNull();
	});

	it("names the PC while controlling Windows", () => {
		const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
		render(<DotSurface agentState="working" connected toggle={vi.fn()} startDrag={vi.fn()} inControl yolo />);
		expect(screen.getByRole("button")).toHaveAccessibleName("Gentle Dot: controlling your PC, yolo mode on");
		agent.mockRestore();
	});

	it("shows the robot pet restarting while disconnected", () => {
		const { dot } = setup("working", false);
		expect(dot).toHaveAccessibleName("Gentle Dot: restarting");
		expect(dot).toHaveClass("dot-restarting");
	});
});
