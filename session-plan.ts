/**
 * Session plan extension
 *
 * A session plan is the set of semantic deliverables this Pi session committed to —
 * "build the search bar", "import bookmarks". It is NOT:
 *   - the Beads backlog (that is durable, repo-wide, and owned by beads.ts)
 *   - an execution checklist ("run lint", "typecheck") — those are commands, not todos
 *
 * Storage is the tool-result details of this extension's own tool, scanned from the session branch
 * on start/tree. That keeps it branch-local, compaction-safe, and free of a second database on disk.
 * A plan item may carry a beadId; the link is a reference only. This extension never writes Beads.
 *
 * Surfaces:
 *   session_plan tool   agent creates/updates the plan; user-only reads
 *   live widget         compact read-only strip, shown while the plan has open items
 *   /todos              full read-only view with scrolling
 *   cmux status         `plan-<session>` pill on the owning workspace, scoped to this session
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

type ItemState = "planned" | "active" | "done" | "dropped";

interface PlanItem {
	id: string;
	title: string;
	state: ItemState;
	beadId?: string;
	note?: string;
}

interface PlanState {
	items: PlanItem[];
	nextId: number;
	updatedAt: number;
}

interface SessionPlanDetails {
	action: string;
	plan: PlanState;
	summary: string;
	error?: string;
}

type ToolText = { type: "text"; text: string };
type ToolResult = { content: ToolText[]; details: SessionPlanDetails };

const CMUX_TIMEOUT_MS = 5_000;

/** Plain `{ type: "string", enum: [...] }`, so every provider accepts it and Static keeps the union. */
function stringEnum<T extends readonly string[]>(values: T, description?: string) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(description ? { description } : {}),
	});
}

function emptyPlan(): PlanState {
	return { items: [], nextId: 1, updatedAt: 0 };
}

function clonePlan(plan: PlanState): PlanState {
	return {
		items: plan.items.map((item) => ({ ...item })),
		nextId: plan.nextId,
		updatedAt: plan.updatedAt,
	};
}

function listedItems(plan: PlanState): PlanItem[] {
	return plan.items;
}

function countedItems(plan: PlanState): PlanItem[] {
	return plan.items.filter((item) => item.state !== "dropped");
}

function isPlanActive(plan: PlanState): boolean {
	return countedItems(plan).some((item) => item.state !== "done");
}

function planCounts(plan: PlanState): { done: number; total: number; active: number } {
	const counted = countedItems(plan);
	return {
		done: counted.filter((item) => item.state === "done").length,
		total: counted.length,
		active: counted.filter((item) => item.state === "active").length,
	};
}

function stateGlyph(state: ItemState): string {
	switch (state) {
		case "done":
			return "✓";
		case "active":
			return "◐";
		case "dropped":
			return "⊘";
		default:
			return "○";
	}
}

function stateTone(state: ItemState): "success" | "accent" | "error" | "dim" {
	switch (state) {
		case "done":
			return "success";
		case "active":
			return "accent";
		case "dropped":
			return "error";
		default:
			return "dim";
	}
}

function shortSession(sessionId: string): string {
	return sessionId.replace(/-/g, "").slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// Read-only surfaces
// ---------------------------------------------------------------------------------------------

/** One-line strip above the editor. Details stay behind /todos. */
class SessionPlanWidget implements Component {
	private cache?: { width: number; lines: string[] };

	constructor(
		private readPlan: () => PlanState,
		private theme: Theme,
	) {}

	render(width: number): string[] {
		if (this.cache && this.cache.width === width) return this.cache.lines;
		const th = this.theme;
		const counts = planCounts(this.readPlan());
		this.cache = {
			width,
			lines: [truncateToWidth(`${th.fg("accent", "plan")} ${th.fg("muted", `${counts.done}/${counts.total} done`)}`, width)],
		};
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

type PlanAction =
	| { type: "exit" }
	| { type: "add" }
	| { type: "toggle"; item: PlanItem }
	| { type: "activate"; item: PlanItem }
	| { type: "edit"; item: PlanItem }
	| { type: "bead"; item: PlanItem }
	| { type: "drop"; item: PlanItem };

/** Full plan, opened with /todos. Keyboard-first and directly editable. */
class PlanScreen implements Component {
	private selected: number;
	private scroll = 0;

	constructor(
		private plan: PlanState,
		private sessionId: string,
		private theme: Theme,
		private tui: TUI,
		private keybindings: KeybindingsManager,
		private done: (action: PlanAction) => void,
		focusId?: string,
	) {
		const items = listedItems(plan);
		const focused = items.findIndex((item) => item.id === focusId);
		const firstOpen = items.findIndex((item) => item.state !== "done");
		this.selected = focused >= 0 ? focused : Math.max(0, firstOpen);
	}

	private items(): PlanItem[] {
		return listedItems(this.plan);
	}

	private viewport(): number {
		return Math.max(5, this.tui.terminal.rows - 7);
	}

	private content(): { lines: string[]; selectedLine: number } {
		const th = this.theme;
		const counts = planCounts(this.plan);
		const lines: string[] = [
			th.fg("accent", ` Session plan  ${shortSession(this.sessionId)}`),
			th.fg("borderMuted", "─".repeat(2)),
			th.fg("muted", `  ${counts.done}/${counts.total} done · ${counts.active} active`),
			"",
		];
		let selectedLine = 4;
		const items = this.items();
		if (items.length === 0) {
			lines.push(th.fg("dim", "  No plan yet. Press a to add the first deliverable."));
			return { lines, selectedLine };
		}
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			const cursor = index === this.selected ? th.fg("accent", "❯") : " ";
			const marker = th.fg(stateTone(item.state), stateGlyph(item.state));
			const id = th.fg("dim", item.id.padEnd(4));
			const dimmed = item.state === "done" || item.state === "dropped";
			const title = dimmed ? th.fg("dim", item.title) : th.fg("text", item.title);
			const bead = item.beadId ? `  ${th.fg("accent", item.beadId)}` : "";
			if (index === this.selected) selectedLine = lines.length;
			lines.push(` ${cursor} ${marker} ${id} ${title}${bead}`);
			if (item.note) lines.push(th.fg("dim", `       ${item.note}`));
		}
		return { lines, selectedLine };
	}

	render(width: number): string[] {
		const { lines, selectedLine } = this.content();
		const viewport = this.viewport();
		if (selectedLine < this.scroll) this.scroll = selectedLine;
		if (selectedLine >= this.scroll + viewport) this.scroll = selectedLine - viewport + 1;
		const maxScroll = Math.max(0, lines.length - viewport);
		this.scroll = Math.min(this.scroll, maxScroll);
		const body = lines.slice(this.scroll, this.scroll + viewport).map((line) => truncateToWidth(line, width));
		const hint = maxScroll > 0 ? `  ${this.scroll + 1}-${this.scroll + body.length}/${lines.length}` : "";
		const help = "  ↑↓ move  ⏎ done  s active  a add  e edit  b bead  d drop  esc close";
		body.push(truncateToWidth(`${hint}${this.theme.fg("dim", help)}`, width));
		return body;
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		const items = this.items();
		const current = items[this.selected];

		if (kb.matches(data, "tui.select.cancel")) {
			this.done({ type: "exit" });
			return;
		}
		if (kb.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.selected = Math.min(items.length - 1, this.selected + 1);
		} else if (kb.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.selected = Math.min(items.length - 1, this.selected + this.viewport());
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.selected = Math.max(0, this.selected - this.viewport());
		} else if (matchesKey(data, "a")) {
			this.done({ type: "add" });
			return;
		} else if (current && (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space"))) {
			this.done({ type: "toggle", item: current });
			return;
		} else if (current && matchesKey(data, "s")) {
			this.done({ type: "activate", item: current });
			return;
		} else if (current && matchesKey(data, "e")) {
			this.done({ type: "edit", item: current });
			return;
		} else if (current && matchesKey(data, "b")) {
			this.done({ type: "bead", item: current });
			return;
		} else if (current && matchesKey(data, "d")) {
			this.done({ type: "drop", item: current });
			return;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

function planText(plan: PlanState, sessionId: string): string {
	const counts = planCounts(plan);
	const lines = [`Session plan ${shortSession(sessionId)} — ${counts.done}/${counts.total} done`];
	if (listedItems(plan).length === 0) {
		lines.push("No plan yet. The agent will add deliverables as it forms one.");
		return lines.join("\n");
	}
	for (const item of listedItems(plan)) {
		const bead = item.beadId ? ` · ${item.beadId}` : "";
		const note = item.note ? ` · ${item.note}` : "";
		lines.push(`${stateGlyph(item.state)} ${item.id} ${item.title}${bead}${note}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let plan = emptyPlan();
	let sessionId = "";
	let widgetMounted = false;
	let widgetComponent: SessionPlanWidget | undefined;
	let widgetTui: TUI | undefined;
	let statusKey: string | undefined;
	let statusPushed = false;

	const workspaceId = process.env.CMUX_WORKSPACE_ID;

	const reconstruct = (ctx: ExtensionContext) => {
		let next = emptyPlan();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			const fromTool = message.role === "toolResult" && message.toolName === "session_plan";
			const fromUserEdit = message.role === "custom" && message.customType === "session-plan";
			if (!fromTool && !fromUserEdit) continue;
			const details = message.details as SessionPlanDetails | undefined;
			if (details?.plan) next = details.plan;
		}
		plan = next;
		sessionId = ctx.sessionManager.getSessionId();
	};

	const syncWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!isPlanActive(plan)) {
			if (widgetMounted) {
				ctx.ui.setWidget("session-plan", undefined);
				widgetMounted = false;
				widgetComponent = undefined;
				widgetTui = undefined;
			}
			return;
		}
		if (!widgetMounted) {
			ctx.ui.setWidget("session-plan", (tui, theme) => {
				widgetTui = tui;
				widgetComponent = new SessionPlanWidget(() => plan, theme);
				return widgetComponent;
			});
			widgetMounted = true;
			return;
		}
		widgetComponent?.invalidate();
		widgetTui?.requestRender();
	};

	const syncCmux = async (ctx: ExtensionContext) => {
		// Print/RPC runs share the workspace env but have no live sidebar; never write status from them.
		if (ctx.mode !== "tui" || !workspaceId || !sessionId) return;
		const key = `plan-${shortSession(sessionId)}`;
		const args = isPlanActive(plan)
			? (() => {
					const counts = planCounts(plan);
					const value = `${counts.done}/${counts.total} done`;
					return [
						"set-status",
						key,
						value,
						"--workspace",
						workspaceId,
						"--icon",
						"sparkle",
						"--color",
						"#4C8DFF",
						"--priority",
						"40",
					];
				})()
			: ["clear-status", key, "--workspace", workspaceId];

		try {
			await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
			statusKey = key;
			statusPushed = isPlanActive(plan);
		} catch {
			// cmux is optional. Never let a sidebar write break the agent turn.
		}
	};

	const clearCmuxOnExit = async () => {
		if (!statusPushed || !statusKey || !workspaceId) return;
		try {
			await pi.exec("cmux", ["clear-status", statusKey, "--workspace", workspaceId], { timeout: CMUX_TIMEOUT_MS });
		} catch {
			// best effort
		}
		statusPushed = false;
	};

	const syncSurfaces = async (ctx: ExtensionContext) => {
		sessionId ||= ctx.sessionManager.getSessionId();
		syncWidget(ctx);
		await syncCmux(ctx);
	};

	/** User edits go through here so they survive reload and reach the agent's next context. */
	const commitPlan = async (ctx: ExtensionContext, next: PlanState, summary: string) => {
		plan = next;
		await syncSurfaces(ctx);
		pi.sendMessage(
			{
				customType: "session-plan",
				content: `Session plan updated: ${summary}\n${planText(plan, sessionId)}`,
				display: false,
				details: { action: "user-edit", plan: clonePlan(plan), summary } satisfies SessionPlanDetails,
			},
			{ deliverAs: "nextTurn" },
		);
	};

	// -----------------------------------------------------------------------------------------
	// Agent tool
	// -----------------------------------------------------------------------------------------

	const ItemInput = Type.Object({
		title: Type.String({ description: "Deliverable, e.g. 'Build the search bar'" }),
		beadId: Type.Optional(Type.String({ description: "Beads issue id this item maps to, if known" })),
		state: Type.Optional(stringEnum(["planned", "active", "done"] as const, "Item state")),
		note: Type.Optional(Type.String({ description: "One-line context, not a command" })),
	});

	const SessionPlanParams = Type.Object({
		action: stringEnum(["set", "add", "update", "drop", "read"] as const, "What to do with this session's plan"),
		items: Type.Optional(Type.Array(ItemInput, { description: "Full plan for action=set" })),
		replace: Type.Optional(Type.Boolean({ description: "Required when set would overwrite a non-empty plan" })),
		title: Type.Optional(Type.String({ description: "Deliverable for add, or new title for update" })),
		beadId: Type.Optional(Type.String({ description: "Beads link; empty string clears it" })),
		note: Type.Optional(Type.String({ description: "One-line context; empty string clears it" })),
		id: Type.Optional(Type.String({ description: "Local item id, e.g. t1" })),
		state: Type.Optional(stringEnum(["planned", "active", "done"] as const, "New state for update; optional for link/note-only edits")),
	});

	interface PlanToolParams {
		action: "set" | "add" | "update" | "drop" | "read";
		replace?: boolean;
		items?: Array<{
			title: string;
			beadId?: string;
			state?: ItemState;
			note?: string;
		}>;
		title?: string;
		beadId?: string;
		note?: string;
		id?: string;
		state?: ItemState;
	}

	const findItem = (params: PlanToolParams): PlanItem | undefined => {
		if (params.id) return plan.items.find((item) => item.id === params.id);
		if (params.beadId) return plan.items.find((item) => item.beadId === params.beadId);
		return undefined;
	};

	pi.registerTool({
		name: "session_plan",
		label: "Session Plan",
		description:
			"Maintain this session's plan of semantic deliverables: set, add, update, drop, read. Items are 'build the search bar' / 'import bookmarks', never verification commands like lint or typecheck. Link a beadId when an item maps to a Beads issue, but never create or close Beads issues here.",
		promptSnippet: "Track this session's semantic deliverables in a glanceable plan (set/add/update/drop/read)",
		promptGuidelines: [
			"Always maintain the session plan with the session_plan tool. Never tell the user to update it themselves or claim you cannot edit it: call session_plan add, update, or drop directly.",
			"Use session_plan for user-visible deliverables and artifacts — 'build the search bar', 'import bookmarks'. Do not put commands whose only purpose is verification, such as lint, typecheck, or test runs, in the plan.",
			"As soon as work starts on an item, call session_plan update with state=active; when it is delivered, call session_plan update with state=done. Drop items that are no longer planned; they stay visible as dropped and can be restored with update state=planned.",
			"Beads is the durable backend for work items, but it does not hold this session's live state. Link session_plan items with beadId when a real issue exists; never create, update, or close Beads issues from session_plan.",
			"session_plan set replaces the whole plan and requires replace=true when a plan already exists. Do not copy the whole Beads backlog into session_plan; it is this session's commitment, not a second task database.",
		],
		parameters: SessionPlanParams,
		prepareArguments(args) {
			const input = args as Record<string, unknown> | undefined;
			if (input?.action === "mark") return { ...input, action: "update" } as Static<typeof SessionPlanParams>;
			return args as Static<typeof SessionPlanParams>;
		},

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<ToolResult> {
			const params = rawParams as PlanToolParams;
			const result = (summary: string, error?: string): ToolResult => ({
				content: [{ type: "text", text: error ?? summary }],
				details: { action: params.action, plan: clonePlan(plan), summary, error },
			});

			let changed = false;
			let summary = "ok";

			switch (params.action) {
				case "set": {
					if (!params.items || params.items.length === 0) {
						return result("session_plan set needs a non-empty `items` array", "`items` is required for set");
					}
					if (plan.items.length > 0 && params.replace !== true) {
						const message = `Plan already has ${plan.items.length} item(s). Pass replace=true to overwrite them.`;
						return result(message, message);
					}
					const previous = plan.items.length;
					const next = emptyPlan();
					for (const entry of params.items) {
						const title = entry.title?.trim();
						if (!title) return result("Every plan item needs a title", "Every plan item needs a title");
						next.items.push({
							id: `t${next.nextId++}`,
							title,
							state: entry.state ?? "planned",
							...(entry.beadId?.trim() ? { beadId: entry.beadId.trim() } : {}),
							...(entry.note?.trim() ? { note: entry.note.trim() } : {}),
						});
					}
					next.updatedAt = Date.now();
					plan = next;
					changed = true;
					summary = `Session plan set to ${plan.items.length} deliverable(s)${previous ? ` (replaced ${previous})` : ""}`;
					break;
				}

				case "add": {
					const title = params.title?.trim();
					if (!title) return result("`title` is required for add", "`title` is required for add");
					const beadId = params.beadId?.trim();
					if (beadId && plan.items.some((item) => item.beadId === beadId)) {
						return result(`${beadId} is already in the plan`, `${beadId} is already in the plan`);
					}
					plan.items.push({
						id: `t${plan.nextId++}`,
						title,
						state: "planned",
						...(beadId ? { beadId } : {}),
						...(params.note?.trim() ? { note: params.note.trim() } : {}),
					});
					plan.updatedAt = Date.now();
					changed = true;
					summary = `Added ${plan.items.at(-1)?.id}: ${title}`;
					break;
				}

				case "update": {
					const item = findItem(params);
					if (!item) return result("Pass `id` or `beadId` for update", "Pass `id` or `beadId` for update");

					const changes: string[] = [];
					const title = params.title?.trim();
					const beadId = params.beadId?.trim();
					const note = params.note?.trim();
					if (params.title !== undefined && !title) return result("`title` cannot be empty", "`title` cannot be empty");
					if (beadId && plan.items.some((other) => other.id !== item.id && other.beadId === beadId)) {
						const message = `${beadId} is already linked to another item`;
						return result(message, message);
					}

					if (title !== undefined && title !== item.title) {
						item.title = title;
						changes.push(`title=${title}`);
					}
					if (params.state !== undefined && params.state !== item.state) {
						item.state = params.state;
						changes.push(`state=${params.state}`);
					}
					if (params.beadId !== undefined) {
						if (beadId) item.beadId = beadId;
						else delete item.beadId;
						changes.push(beadId ? `bead=${beadId}` : "bead cleared");
					}
					if (params.note !== undefined) {
						if (note) item.note = note;
						else delete item.note;
						changes.push(note ? `note=${note}` : "note cleared");
					}
					if (changes.length === 0) {
						return result("Nothing to update: pass state, title, beadId, or note", "Nothing to update: pass state, title, beadId, or note");
					}
					plan.updatedAt = Date.now();
					changed = true;
					summary = `${item.id} ${changes.join(" · ")}`;
					break;
				}

				case "drop": {
					const item = findItem(params);
					if (!item) return result("Pass `id` or `beadId` for drop", "Pass `id` or `beadId` for drop");
					item.state = "dropped";
					plan.updatedAt = Date.now();
					changed = true;
					summary = `Dropped ${item.id}: ${item.title} (still visible; restore with update state=planned)`;
					break;
				}

				case "read":
					return result(planText(plan, sessionId || ctx.sessionManager.getSessionId()));

				default:
					return result(`Unknown action: ${params.action}`, `Unknown action: ${params.action}`);
			}

			if (changed) await syncSurfaces(ctx);
			const final = result(summary);
			final.content[0].text = `${summary}\n${planText(plan, sessionId || ctx.sessionManager.getSessionId())}`;
			return final;
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("session_plan ")) + theme.fg("muted", args.action ?? "");
			if (args.action === "set" && args.items) text += ` ${theme.fg("dim", `${args.items.length} items`)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			if (args.state) text += ` ${theme.fg("muted", args.state)}`;
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			return { render: () => [text], invalidate: () => {} };
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SessionPlanDetails | undefined;
			const text = details?.error ? theme.fg("error", details.error) : theme.fg("muted", details?.summary ?? "");
			const lines = [text];
			if (!details?.error && details?.plan) {
				const counts = planCounts(details.plan);
				lines.push(theme.fg("dim", `${counts.done}/${counts.total} done`));
				const items = listedItems(details.plan);
				const shown = expanded ? items : items.slice(0, 5);
				for (const item of shown) {
					const bead = item.beadId ? ` ${theme.fg("accent", item.beadId)}` : "";
					const note = item.note ? ` ${theme.fg("dim", item.note)}` : "";
					lines.push(
						`  ${theme.fg(stateTone(item.state), stateGlyph(item.state))} ${theme.fg("dim", item.id)} ${theme.fg("muted", item.title)}${bead}${note}`,
					);
				}
				if (items.length > shown.length) lines.push(theme.fg("dim", `  … ${items.length - shown.length} more`));
			}
			return { render: (width: number) => lines.map((line) => truncateToWidth(line, width)), invalidate: () => {} };
		},
	});

	// -----------------------------------------------------------------------------------------
	// User command
	// -----------------------------------------------------------------------------------------

	const openPlan = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(planText(plan, sessionId || ctx.sessionManager.getSessionId()), "info");
			return;
		}

		let focusId: string | undefined;
		while (true) {
			const action = await ctx.ui.custom<PlanAction>((tui, theme, keybindings, done) =>
				new PlanScreen(plan, sessionId || ctx.sessionManager.getSessionId(), theme, tui, keybindings, done, focusId),
			);
			if (!action || action.type === "exit") return;

			const next = clonePlan(plan);
			let nextFocus = "item" in action ? action.item.id : undefined;

			switch (action.type) {
				case "add": {
					const title = await ctx.ui.input("Add to session plan", "Deliverable, not a command");
					if (!title?.trim()) break;
					const bead = await ctx.ui.input("Beads id (optional)", "viaana-xxxx");
					const item: PlanItem = {
						id: `t${next.nextId++}`,
						title: title.trim(),
						state: "planned",
						...(bead?.trim() ? { beadId: bead.trim() } : {}),
					};
					next.items.push(item);
					next.updatedAt = Date.now();
					nextFocus = item.id;
					await commitPlan(ctx, next, `added ${item.id}: ${item.title}`);
					break;
				}
				case "toggle":
				case "activate": {
					const item = next.items.find((candidate) => candidate.id === action.item.id);
					if (!item) break;
					item.state =
						action.type === "activate"
							? "active"
							: item.state === "done" || item.state === "dropped"
								? "planned"
								: "done";
					next.updatedAt = Date.now();
					await commitPlan(ctx, next, `${item.id} → ${item.state}`);
					break;
				}
				case "edit": {
					const item = next.items.find((candidate) => candidate.id === action.item.id);
					if (!item) break;
					const title = await ctx.ui.input("Edit deliverable", item.title);
					if (!title?.trim() || title.trim() === item.title) break;
					item.title = title.trim();
					next.updatedAt = Date.now();
					await commitPlan(ctx, next, `${item.id} renamed: ${item.title}`);
					break;
				}
				case "bead": {
					const item = next.items.find((candidate) => candidate.id === action.item.id);
					if (!item) break;
					const bead = await ctx.ui.input("Beads id (empty to clear)", item.beadId ?? "");
					if (bead === undefined) break;
					if (bead.trim()) item.beadId = bead.trim();
					else delete item.beadId;
					next.updatedAt = Date.now();
					await commitPlan(ctx, next, `${item.id} ${item.beadId ? `linked to ${item.beadId}` : "unlinked"}`);
					break;
				}
				case "drop": {
					const item = next.items.find((candidate) => candidate.id === action.item.id);
					if (!item) break;
					const ok = await ctx.ui.confirm(
						`Drop ${item.id}?`,
						`${item.title}\n\nIt stays visible as dropped and can be restored with the done toggle.`,
					);
					if (!ok) break;
					item.state = "dropped";
					next.updatedAt = Date.now();
					await commitPlan(ctx, next, `dropped ${item.id}: ${item.title}`);
					break;
				}
			}

			focusId = nextFocus;
		}
	};

	pi.registerCommand("todos", {
		description: "Show and edit this session's plan",
		handler: (_args, ctx) => openPlan(ctx),
	});

	// -----------------------------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		await syncSurfaces(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		await syncSurfaces(ctx);
	});

	pi.on("session_shutdown", () => {
		widgetMounted = false;
		widgetComponent = undefined;
		widgetTui = undefined;
		void clearCmuxOnExit();
	});
}
