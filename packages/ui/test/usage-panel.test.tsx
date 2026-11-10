import type { ClientMessage, ServerMessage, ServerPayload, UsageEntry } from "@gentle-dot/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { UsagePanel } from "../src/components/UsagePanel.tsx";
import { type DotAction, type DotState, initialState, reduce, type UsageState } from "../src/store.ts";

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

const older: UsageEntry = {
	ts: "2026-11-09T12:34:56.000Z",
	sessionId: "s1",
	provider: "nan",
	model: "big",
	thinkingLevel: "high",
	input: 1200,
	output: 340,
	cacheRead: 5600,
	cacheWrite: 0,
	totalTokens: 7140,
	cost: 0.012345,
	durationMs: 2340,
	stopReason: "end_turn",
};

const newer: UsageEntry = {
	ts: "2026-11-09T12:40:00.000Z",
	provider: "openai",
	model: "gpt-5",
	input: 300,
	output: 400,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 700,
	cost: 0.487655,
	durationMs: 420,
};

const usage: ServerPayload = {
	type: "usage",
	entries: [older, newer],
	totals: {
		calls: 2,
		input: 1500,
		output: 740,
		cacheRead: 5600,
		cacheWrite: 0,
		totalTokens: 7840,
		cost: 0.5,
	},
};

const zeroUsage: ServerPayload = {
	type: "usage",
	entries: [],
	totals: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
};

function renderPanel(
	usageState: {
		open?: boolean;
		loaded?: boolean;
		entries?: UsageEntry[];
		totals?: UsageState["totals"];
	} = {},
) {
	const usage: UsageState = {
		open: true,
		loaded: false,
		entries: [],
		...usageState,
	};
	const dispatch = vi.fn();
	render(<UsagePanel usage={usage} dispatch={dispatch} />);
	return dispatch;
}

describe("usage store state", () => {
	it("keeps usage data when a payload arrives without opening the panel", () => {
		const s = apply({ ...initialState, connection: "open", agentState: "idle" }, usage);
		expect(s.usage).toMatchObject({ open: false, loaded: true, entries: [older, newer] });
	});

	it("opening usage closes the other panels, and the other panels close usage", () => {
		let s = reduce(
			{ ...initialState, connection: "open", agentState: "idle" },
			{
				type: "profiles",
				open: true,
			},
		);
		expect(s.profiles.open).toBe(true);
		s = reduce(s, { type: "usage", open: true });
		expect(s.usage).toMatchObject({ open: true, loaded: false });
		expect(s.profiles.open).toBe(false);
		s = reduce(s, { type: "profiles", open: true });
		expect(s.profiles.open).toBe(true);
		expect(s.usage.open).toBe(false);
	});

	it("closing usage keeps the loaded data for the next time", () => {
		let s = apply(initialState, usage);
		s = reduce(s, { type: "usage", open: true });
		s = reduce(s, { type: "usage", open: false });
		expect(s.usage.open).toBe(false);
		expect(s.usage.entries).toEqual([older, newer]);
	});
});

describe("UsagePanel", () => {
	it("shows Loading… until the first payload arrives", () => {
		renderPanel();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("shows totals and one row per call, newest first", () => {
		renderPanel({ loaded: true, entries: usage.entries, totals: usage.totals });
		expect(screen.queryByText("Loading…")).toBeNull();
		const totals = screen.getByRole("group", { name: "Usage totals" });
		expect(totals).toHaveTextContent("2 calls");
		expect(totals).toHaveTextContent("$0.50");
		expect(totals).toHaveTextContent("in 1.5k");
		expect(totals).toHaveTextContent("out 740");
		expect(totals).toHaveTextContent("cache read 5.6k");
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		// Newest first: gpt-5 (no thinking level) above nan/big.
		expect(rows[0]).toHaveTextContent("openai/gpt-5");
		expect(rows[0]).toHaveTextContent("$0.4877");
		expect(rows[0]).toHaveTextContent("in 300 · out 400");
		expect(rows[0]).toHaveTextContent("420ms");
		expect((rows[0] as HTMLElement).querySelector("time")?.getAttribute("datetime")).toBe(
			"2026-11-09T12:40:00.000Z",
		);
		expect(rows[1]).toHaveTextContent("nan/big");
		expect(rows[1]).toHaveTextContent("high");
		expect(rows[1]).toHaveTextContent("in 1.2k · out 340");
		expect(rows[1]).toHaveTextContent("2.3s");
		expect(rows[1]).toHaveTextContent("$0.0123");
	});

	it("says when no calls have been recorded yet", () => {
		renderPanel({ loaded: true, entries: [], totals: zeroUsage.totals });
		expect(screen.getByText("No model calls recorded yet.")).toBeInTheDocument();
		expect(screen.queryAllByRole("listitem")).toEqual([]);
	});

	it("shows a failed call's error message", () => {
		const failed: UsageEntry = { ...newer, errorMessage: "The model is not available." };
		renderPanel({ loaded: true, entries: [failed], totals: usage.totals });
		const row = screen.getByRole("listitem");
		expect(row).toHaveTextContent("The model is not available.");
		expect(row).toHaveClass("usage-error");
	});

	it("closes from its own header button", async () => {
		const dispatch = renderPanel({ loaded: true, entries: usage.entries, totals: usage.totals });
		await userEvent.click(screen.getByRole("button", { name: "Close usage" }));
		expect(dispatch).toHaveBeenCalledWith({ type: "usage", open: false });
	});
});

describe("ChatSurface usage entry point", () => {
	let dispatchServer: (payload: ServerPayload) => void = () => {};

	function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
		const [state, dispatch] = useReducer(reduce, initial);
		dispatchServer = (payload) =>
			act(() => dispatch({ type: "server", message: { ...payload, seq: 1 } as ServerMessage } as DotAction));
		return <ChatSurface variant="web" state={state} send={send} dismiss={vi.fn()} dispatch={dispatch} />;
	}

	it("the header button asks for usage, opens the panel, and fills it from the payload", async () => {
		const send = vi.fn();
		render(<Harness initial={{ ...initialState, connection: "open", agentState: "idle" }} send={send} />);
		await userEvent.click(screen.getByRole("button", { name: "Usage" }));
		expect(send).toHaveBeenCalledWith({ type: "usage_list" });
		expect(screen.getByRole("region", { name: "Usage" })).toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		dispatchServer(usage);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		// The panel covers the chat while it is open.
		expect(document.querySelector("main.chat-body[hidden]")).not.toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Close usage" }));
		expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
	});

	it("typing again closes the usage panel with the other screens", async () => {
		const send = vi.fn();
		render(<Harness initial={{ ...initialState, connection: "open", agentState: "idle" }} send={send} />);
		await userEvent.click(screen.getByRole("button", { name: "Usage" }));
		expect(screen.getByRole("region", { name: "Usage" })).toBeInTheDocument();
		const composer = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(composer, "hi");
		expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
	});
});
