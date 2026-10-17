import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme,
	type ExtensionContext, type Theme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ConversationInfo, ConversationSnapshot, TranscriptSource } from "./viewer-types.ts";

// Each overlay owns its subscription and cached presentation; execution stays with the source.
export class SubagentViewer implements Component {
	private tui: TUI;
	private theme: Theme;
	private keys: KeybindingsManager;
	private source: TranscriptSource;
	private done: () => void;
	private unsubscribe: () => void = () => {};
	private disposed = false;
	private items: ConversationInfo[] = [];
	private selected = 0;
	private handle?: string;
	private snapshot?: ConversationSnapshot;
	private diagnostic = "";
	private deleted = false;
	private offset = 0;
	private maximum = 0;
	private height = 1;
	private follow = true;
	private thinking = false;
	private instructions = false;
	private tools = false;
	private cache = new Map<string, { signature: string; component: Component }>();

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, source: TranscriptSource, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.source = source;
		this.done = done;
		this.refresh();
		this.unsubscribe = source.subscribe(() => {
			if (this.disposed) return;
			this.refresh();
			this.tui.requestRender();
		});
	}

	private refresh(): void {
		try {
			const selectedHandle = this.selected > 0 ? this.items[this.selected - 1]?.handle : undefined;
			this.items = this.source.list().sort((a, b) => a.createdAt - b.createdAt || a.handle.localeCompare(b.handle));
			const selectedIndex = selectedHandle ? this.items.findIndex(item => item.handle === selectedHandle) : -1;
			this.selected = selectedIndex >= 0 ? selectedIndex + 1 : Math.min(this.selected, this.items.length);
			this.diagnostic = "";
			if (this.handle) {
				this.deleted = !this.items.some(item => item.handle === this.handle);
				if (!this.deleted || !this.snapshot) this.snapshot = this.source.inspect(this.handle);
			}
		} catch (error) {
			this.diagnostic = `Transcript unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	invalidate(): void {
		this.cache.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.cache.clear();
	}

	close(): void {
		if (this.disposed) return;
		this.dispose();
		this.done();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const key = (name: string) => matchesKey(data, name as Parameters<typeof matchesKey>[1]);
		if (key("escape") || key("ctrl+c") || this.keys.matches(data, "tui.select.cancel")) {
			if (this.handle) {
				this.handle = undefined;
				this.snapshot = undefined;
				this.offset = 0;
				this.refresh();
			} else this.close();
		} else if (!this.handle) {
			if (this.keys.matches(data, "tui.select.up") || key("up")) this.selected = Math.max(0, this.selected - 1);
			if (this.keys.matches(data, "tui.select.down") || key("down")) this.selected = Math.min(this.items.length, this.selected + 1);
			if (key("home")) this.selected = 0;
			if (key("end")) this.selected = this.items.length;
			if (this.keys.matches(data, "tui.select.confirm") || key("return")) {
				if (this.selected === 0) this.close();
				else {
					this.handle = this.items[this.selected - 1]?.handle;
					this.offset = 0;
					this.follow = true;
					this.deleted = false;
					this.invalidate();
					this.refresh();
				}
			}
		} else {
			if (key("home")) { this.offset = 0; this.follow = false; }
			else if (key("end")) this.follow = true;
			else if (key("up") || key("pageUp")) {
				this.offset = Math.max(0, this.offset - (key("pageUp") ? this.height : 1));
				this.follow = false;
			} else if (key("down") || key("pageDown")) {
				this.offset = Math.min(this.maximum, this.offset + (key("pageDown") ? this.height : 1));
				this.follow = this.offset === this.maximum;
			} else if (key("t") || this.keys.matches(data, "app.thinking.toggle")) { this.thinking = !this.thinking; this.invalidate(); }
			else if (key("i")) { this.instructions = !this.instructions; this.invalidate(); }
			else if (key("o") || this.keys.matches(data, "app.tools.expand")) { this.tools = !this.tools; this.invalidate(); }
		}
		// Unrecognised input is consumed by the overlay, including parent execution shortcuts.
		if (!this.disposed) this.tui.requestRender();
	}

	private transcript(width: number): string[] {
		const snapshot = this.snapshot;
		if (!snapshot) return [];
		const lines: string[] = [];
		const text = (value: string) => lines.push(...new Text(value, 0, 0).render(width));
		if (snapshot.instructions) {
			text(`Delegated instructions [i: ${this.instructions ? "expanded" : "collapsed"}]`);
			if (this.instructions) text(snapshot.instructions);
		}
		const results = new Map(snapshot.messages.filter(entry => entry.message.role === "toolResult")
			.map(entry => [entry.message.toolCallId, entry]));
		const calls = new Set(snapshot.messages.flatMap(entry => Array.isArray(entry.message.content) ? entry.message.content.filter(block => block.type === "toolCall").map(block => block.id) : []));
		const used = new Set<string>();
		const cached = (id: string, signature: string, create: () => Component) => {
			used.add(id);
			let value = this.cache.get(id);
			if (!value || value.signature !== signature) {
				value = { signature, component: create() };
				this.cache.set(id, value);
			}
			lines.push(...value.component.render(width));
		};
		for (const entry of snapshot.messages) {
			const message = entry.message;
			const blocks = Array.isArray(message.content) ? message.content : [];
			if (message.role === "assistant") {
				const visibleThinking = blocks.some(block => block.type === "thinking" && block.thinking && !block.redacted);
				text(visibleThinking ? `Thinking [t: ${this.thinking ? "expanded" : "collapsed"}]` : "Thinking unavailable (not recorded or withheld by provider)");
				cached(entry.key, JSON.stringify(entry), () => {
					const component = new AssistantMessageComponent(undefined, !this.thinking, getMarkdownTheme());
					component.updateContent({ ...message, content: blocks.filter(block => block.type !== "toolCall") } as any, !!entry.pending);
					return component;
				});
				for (const block of blocks.filter(block => block.type === "toolCall")) {
					const result = results.get(block.id);
					text(`Tool ${block.name} [o: ${this.tools ? "expanded" : "collapsed"}]${!result || result.pending ? " · pending" : ""}`);
					if (this.tools) cached(`tool:${block.id}`, JSON.stringify([block, result]), () => {
						const component = new ToolExecutionComponent(block.name, block.id, block.arguments, { showImages: false }, undefined, this.tui, snapshot.info.cwd);
						component.setExpanded(true);
						if (result) component.updateResult(result.message as any, !!result.pending);
						return component;
					});
				}
			} else if (message.role === "user") {
				cached(entry.key, JSON.stringify(entry), () => new UserMessageComponent(typeof message.content === "string" ? message.content : blocks.map(block => block.text ?? "[image]").join("\n"), getMarkdownTheme()));
			} else if (message.role === "system") {
				text(`System instructions [i: ${this.instructions ? "expanded" : "collapsed"}]`);
				if (this.instructions) text(JSON.stringify(message, null, 2));
			} else if (message.role === "toolResult" && !calls.has(message.toolCallId)) {
				text(`Tool ${message.toolName ?? "unknown"} [o: ${this.tools ? "expanded" : "collapsed"}]${entry.pending ? " · pending" : ""}`);
				if (this.tools) cached(entry.key, JSON.stringify(entry), () => {
					const component = new ToolExecutionComponent(message.toolName ?? "unknown", message.toolCallId ?? entry.key, message.arguments ?? {}, { showImages: false }, undefined, this.tui, snapshot.info.cwd);
					component.setExpanded(true);
					component.updateResult(message as any, !!entry.pending);
					return component;
				});
			} else if (message.role !== "toolResult") text(typeof message.content === "string" ? message.content : JSON.stringify(message, null, 2));
		}
		for (const id of this.cache.keys()) if (!used.has(id)) this.cache.delete(id);
		if (snapshot.diagnostics) text(snapshot.diagnostics);
		return lines;
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const rows = Math.max(1, this.tui.terminal.rows);
		this.height = Math.max(1, rows - 2);
		let title = "Subagents · read-only";
		let body: string[];
		let footer = "↑↓ select · Enter view · Esc close";
		if (this.handle) {
			title = `[${this.snapshot?.info.status ?? "unknown"}] ${this.snapshot?.info.label ?? "Transcript"}${this.deleted ? " · deleted" : ""} · read-only`;
			body = this.transcript(width);
			if (this.diagnostic) body.push(...new Text(this.diagnostic, 0, 0).render(width));
			this.maximum = Math.max(0, body.length - this.height);
			this.offset = this.follow ? this.maximum : Math.min(this.offset, this.maximum);
			body = body.slice(this.offset, this.offset + this.height);
			footer = `${this.follow ? "Following" : "Follow paused"} · ↑↓ PgUp/PgDn Home/End · t thinking · i instructions · o tools · Esc back`;
		} else {
			const labels = ["Parent session", ...this.items.map(item => `[${item.status}] ${item.label} · ${item.creator} · ${item.agent ?? "agent unknown"} · ${item.model ?? "model unknown"}`)];
			body = labels.map((label, index) => `${index === this.selected ? "→" : " "} ${label}`);
			body = body.slice(Math.max(0, this.selected - this.height + 1), Math.max(this.height, this.selected + 1));
			if (this.diagnostic) body.push(this.diagnostic);
		}
		const output = [this.theme.fg("accent", title), ...body.slice(0, this.height)];
		while (output.length < rows - 1) output.push("");
		output.push(this.theme.fg("dim", footer));
		return output.slice(0, rows).map(line => truncateToWidth(line, width, ""));
	}
}

export async function showSubagents(ctx: ExtensionContext, source: TranscriptSource, signal: AbortSignal | undefined = ctx.signal): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The subagent viewer requires terminal mode.", "info");
		return;
	}
	let viewer: SubagentViewer | undefined;
	const close = () => viewer?.close();
	try {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			viewer = new SubagentViewer(tui, theme, keys, source, done);
			signal?.addEventListener("abort", close, { once: true });
			if (signal?.aborted) queueMicrotask(close);
			return viewer;
		}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
	} finally {
		signal?.removeEventListener("abort", close);
		viewer?.dispose();
	}
}
