import { basename } from "node:path";
import type { ActivityKind } from "@gentle-dot/protocol";

/** The life cycle of one tool call, as the activity list shows it. */
export type ActivityStatus = "running" | "done" | "failed";

/** The titles of one tool family: while it runs, once it succeeded, once it failed. */
type Tense = readonly [running: string, done: string, failed: string];

function truncate(str: string, maxLen = 35): string {
	const clean = str.replace(/\s+/g, " ").trim();
	return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

/**
 * Turns an internal tool call into a neutral activity. Tool names never reach
 * the user; only the kind and a short human title do. The title matches the
 * call's status, so a finished or failed call never shows as still running.
 */
export function describeTool(
	toolName: string,
	args: unknown,
	status: ActivityStatus = "running",
): { kind: ActivityKind; title: string } {
	let raw = toolName.toLowerCase();
	// Strip mcp__<server>__ prefix if present
	const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(raw);
	if (mcpMatch?.[1]) raw = mcpMatch[1];

	const file = fileOf(args);
	const query = queryOf(args);
	const cmd = commandOf(args);
	const label = labelOf(args);

	const titled = (kind: ActivityKind, titles: Tense): { kind: ActivityKind; title: string } => ({
		kind,
		title: status === "running" ? titles[0] : status === "done" ? titles[1] : titles[2],
	});

	if (raw === "read")
		return titled(
			"read",
			file
				? ([`Reading ${file}`, `Read ${file}`, `Could not read ${file}`] as const)
				: (["Reading a file", "Read a file", "Could not read a file"] as const),
		);
	if (raw === "write" || raw === "edit")
		return titled(
			"edit",
			file
				? ([`Editing ${file}`, `Edited ${file}`, `Could not edit ${file}`] as const)
				: (["Editing a file", "Edited a file", "Could not edit a file"] as const),
		);
	if (raw === "bash") {
		if (cmd) {
			const short = truncate(cmd, 30);
			return titled("run", [`Running: ${short}`, `Ran: ${short}`, `Command failed: ${short}`]);
		}
		return titled("run", ["Running a command", "Ran a command", "A command failed"]);
	}

	// Google Workspace
	if (raw === "search_drive_files") {
		return titled(
			"search",
			query
				? ([
						`Searching Drive: "${truncate(query, 25)}"`,
						`Searched Drive: "${truncate(query, 25)}"`,
						"Could not search Drive",
					] as const)
				: (["Searching Drive", "Searched Drive", "Could not search Drive"] as const),
		);
	}
	if (raw === "get_drive_file_content" || raw === "get_doc_content") {
		const target = file || docOf(args);
		return titled(
			"read",
			target
				? ([
						`Reading doc: ${truncate(target, 28)}`,
						`Read doc: ${truncate(target, 28)}`,
						`Could not read doc: ${truncate(target, 28)}`,
					] as const)
				: (["Reading Drive doc", "Read Drive doc", "Could not read Drive doc"] as const),
		);
	}
	if (raw === "search_gmail_messages") {
		return titled(
			"search",
			query
				? ([
						`Searching Gmail: "${truncate(query, 25)}"`,
						`Searched Gmail: "${truncate(query, 25)}"`,
						"Could not search Gmail",
					] as const)
				: (["Searching Gmail", "Searched Gmail", "Could not search Gmail"] as const),
		);
	}
	if (raw === "get_gmail_thread_content" || raw === "get_gmail_message_content") {
		return titled("read", ["Reading email thread", "Read email thread", "Could not read email thread"]);
	}
	if (raw === "get_gmail_attachment_content") {
		return titled(
			"read",
			file
				? ([
						`Downloading attachment: ${file}`,
						`Downloaded attachment: ${file}`,
						`Could not download attachment: ${file}`,
					] as const)
				: (["Downloading attachment", "Downloaded attachment", "Could not download attachment"] as const),
		);
	}
	if (raw === "list_spreadsheets" || raw === "read_sheet_values") {
		return titled("read", ["Reading spreadsheet", "Read spreadsheet", "Could not read spreadsheet"]);
	}
	if (raw === "modify_sheet_values" || raw === "create_spreadsheet") {
		return titled("edit", ["Updating spreadsheet", "Updated spreadsheet", "Could not update spreadsheet"]);
	}

	// Computer control
	if (raw === "screenshot")
		return titled("run", ["Taking screenshot", "Took screenshot", "Could not take screenshot"]);
	if (raw === "mouse_move") return titled("run", ["Moving cursor", "Moved cursor", "Could not move cursor"]);
	if (raw === "mouse_click")
		return titled("run", ["Clicking screen", "Clicked screen", "Could not click screen"]);
	if (raw.startsWith("keyboard_"))
		return titled("run", ["Typing input", "Typed input", "Could not type input"]);

	// Tasks and workflow
	if (raw === "todo") {
		const action = (args as Record<string, unknown> | null)?.action;
		const tasks = (args as Record<string, unknown> | null)?.tasks;
		const count = Array.isArray(tasks) ? tasks.length : 0;
		if (action === "write" && count > 0)
			return titled("other", [
				`Planning tasks (${count} items)`,
				`Planned ${count} tasks`,
				"Could not plan tasks",
			]);
		return titled("other", ["Updating task list", "Updated task list", "Could not update task list"]);
	}
	if (raw === "gentle_odd_phase") {
		const phase = (args as Record<string, unknown> | null)?.phase;
		return titled("other", [
			phase ? `Phase: ${String(phase)}` : "Workflow step",
			phase ? `Phase: ${String(phase)}` : "Workflow step",
			"Workflow step",
		]);
	}

	// Memory
	if (raw.startsWith("mem_save") || raw === "mem_update" || raw === "mem_session_summary") {
		const topic = (args as Record<string, unknown> | null)?.topic;
		return titled(
			"memory",
			typeof topic === "string" && topic
				? ([
						`Saving note: ${truncate(topic, 25)}`,
						`Saved note: ${truncate(topic, 25)}`,
						`Could not save note: ${truncate(topic, 25)}`,
					] as const)
				: (["Saving a note", "Saved a note", "Could not save a note"] as const),
		);
	}
	if (raw.startsWith("mem_"))
		return titled("memory", ["Checking my notes", "Checked my notes", "Could not check my notes"]);

	// Helpers
	if (raw.startsWith("subagent_")) {
		if (label) {
			const short = truncate(label, 30);
			return titled("delegate", [
				`Asking helper: "${short}"`,
				`Helper finished: "${short}"`,
				`Helper failed: "${short}"`,
			]);
		}
		return titled("delegate", ["Asking a helper", "Asked a helper", "Could not ask a helper"]);
	}

	// Web search
	if (["web_search", "fetch_content", "get_search_content", "source_check"].includes(raw)) {
		if (query) {
			const short = truncate(query, 25);
			return titled("search", [
				`Looking up: "${short}"`,
				`Looked up: "${short}"`,
				`Could not look up: "${short}"`,
			]);
		}
		return titled("search", [
			"Looking things up online",
			"Looked things up online",
			"Could not look things up online",
		]);
	}
	if (["grep", "find", "ls"].includes(raw) || raw.startsWith("codegraph"))
		return titled("search", ["Searching files", "Searched files", "Could not search files"]);
	if (raw.startsWith("ask_user")) return titled("other", ["Asking you", "Asked you", "Could not ask you"]);

	// Unknown or generic tool
	if (raw !== "mystery" && raw.length > 0) {
		const words = raw.replace(/[_-]+/g, " ");
		const human = words.charAt(0).toUpperCase() + words.slice(1);
		return titled("other", [`Running ${human}`, human, `Failed ${human}`]);
	}

	return titled("other", ["Working", "Finished", "Failed"]);
}

function fileOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const path =
		record.path ?? record.file_path ?? record.filePath ?? record.Path ?? record.filename ?? record.file_name;
	return typeof path === "string" && path !== "" ? basename(path) : undefined;
}

function docOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const val = record.document_id ?? record.file_id ?? record.title ?? record.name;
	return typeof val === "string" && val !== "" ? val : undefined;
}

function queryOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const q = record.query ?? record.q ?? record.queries;
	if (typeof q === "string" && q.trim()) return q.trim();
	if (Array.isArray(q) && typeof q[0] === "string" && q[0].trim()) return q[0].trim();
	return undefined;
}

function commandOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const cmd = record.command ?? record.CommandLine;
	if (typeof cmd !== "string" || !cmd.trim()) return undefined;
	return cmd.trim().split("\n")[0]?.trim();
}

function labelOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const val = record.label ?? record.task ?? record.agent;
	return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

/** Plain text of a user or assistant message whose content is a string or content blocks. */
export function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			const b = block as { type?: string; text?: unknown };
			return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
		})
		.join("");
}

/** Thinking / reasoning text of an assistant message whose content has thinking blocks. */
export function thinkingOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			const b = block as { type?: string; thinking?: unknown; text?: unknown };
			if (b?.type === "thinking") {
				const val = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
				return val ? [val] : [];
			}
			return [];
		})
		.join("\n\n");
}
