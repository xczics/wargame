/**
 * Client plugin host — the browser-side mirror of the server kernel. The core only
 * wires things up; every visible feature is a client plugin that registers Vue
 * components into the layout (see ../plugins.ts and docs/design/ui.md):
 *
 * - two fixed bands: `top` (page tabs plus band items) and `bottom` (status marks);
 * - pages between them, either two columns (left 1/3, right 2/3, each scrolling on its
 *   own) filled with blocks by any plugin, or a single component that takes the page over;
 * - entries (e.g. a building): opening one on a two-column page swaps the right column for
 *   the blocks registered on that kind of entry.
 *
 * Plugins talk to each other through client services, typed by augmenting
 * `ClientServiceMap` (same pattern as the server's `ServiceMap`).
 */
import { computed, inject, markRaw, reactive, ref, shallowRef, type Component, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import type { ClientState, Meta, ViewMap } from '../../src/shared/api';
import { ApiError, request } from './api';
import { createI18n, type Messages } from './i18n';

/** The fixed bands above and below the page. */
export type BandName = 'top' | 'bottom';
export type ColumnName = 'left' | 'right';
/** Blocks registered for this page id appear on every two-column page. */
export const EVERY_PAGE = '*';

/** Something opened in the right column instead of the page's own blocks, e.g. a building. */
export interface Entry {
	/** Selects the blocks, e.g. `building`. */
	kind: string;
	/** Identifies this entry within its kind; opening the same one again keeps it. */
	id: string;
	/** Narrows blocks registered with `types`, e.g. the building type. */
	type?: string;
	/** Heading above the blocks (translated). */
	label: string;
	/** Whatever the blocks need to find their data, e.g. settlement / district / slot. */
	data?: Record<string, string>;
}

/** Services client plugins expose to each other. Augmented by plugins. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClientServiceMap {}

export interface ClientPlugin {
	id: string;
	dependsOn?: string[];
	setup(game: Game): void | Promise<void>;
}

export const defineClientPlugin = (plugin: ClientPlugin) => plugin;

export interface Game {
	readonly meta: Meta;
	/** Last authoritative state from the server (null before the first sync). */
	readonly state: Readonly<ShallowRef<ClientState | null>>;
	/** Seconds since `state` arrived, ticking ~10x/s. Use it in `computed` to interpolate. */
	readonly elapsed: Readonly<Ref<number>>;
	/** Estimated server time now (ms): the state's `now` plus time elapsed since. Reactive. */
	serverNow(): number;
	/** Typed access to a server view in the current state. */
	view<K extends keyof ViewMap>(id: K): ViewMap[K] | undefined;
	/** Ask for a view to be included in every state sync (call during setup). */
	need(...ids: (keyof ViewMap | string)[]): void;
	/** Parameters sent with every sync and command (e.g. `settlement`). Setting one resyncs. */
	readonly params: Readonly<Record<string, string>>;
	setParam(name: string, value: string | undefined): Promise<void>;
	request: typeof request;
	/** Run a player command; shows a toast and resolves false on failure. */
	command(type: string, payload?: unknown): Promise<boolean>;
	refresh(): Promise<void>;
	/** Resync once the server clock reaches `serverTime` (ms), e.g. when a construction finishes. */
	refreshAt(serverTime: number): void;
	/** Render `component` in a fixed band. Lower `order` renders first. */
	band(name: BandName, component: Component, options?: { order?: number }): void;
	/**
	 * Add a page tab. Without `component` the page is two columns filled by `block()`;
	 * with it, the component takes over the whole area between the bands (maps, consoles).
	 */
	page(id: string, label: string, options?: { order?: number; component?: Component }): void;
	/**
	 * Put a block in a column of a page (`EVERY_PAGE` for all two-column pages). Blocks stack
	 * top to bottom by `order`; the page may be registered by another plugin, before or after.
	 */
	block(page: string, column: ColumnName, component: Component, options?: { order?: number }): void;
	/**
	 * Show `component` (it receives the entry as prop `entry`) whenever an entry of `kind` is
	 * open; `types` limits it to some entry types. The plugin that owns the kind puts its own
	 * summary first with a low `order`; others default to 0 and stack below.
	 */
	entryBlock(kind: string, component: Component, options?: { order?: number; types?: string[] }): void;
	/** Switch to a page (e.g. from a notification in a band); `entry` also opens an entry there. */
	showPage(id: string, entry?: Entry | null): void;
	/** Open an entry in the right column of the current page; null goes back to the page. */
	openEntry(entry: Entry | null): void;
	/** The entry open on the current page, if any. Reactive. */
	readonly entry: Readonly<Ref<Entry | null>>;
	/** Replace the whole UI with `component` (e.g. a login screen) and stop booting further plugins. */
	gate(component: Component): void;
	provide<K extends keyof ClientServiceMap>(name: K, impl: ClientServiceMap[K]): void;
	use<K extends keyof ClientServiceMap>(name: K): ClientServiceMap[K];
	toast(message: string, kind?: 'error' | 'info'): void;
	/** Translate a source (English) string into the current locale. Reactive in templates. */
	t(text: string, vars?: Record<string, string | number>): string;
	/** Register translations for a locale (plugins ship their own). */
	messages(locale: string, messages: Messages): void;
	readonly locale: Readonly<Ref<string>>;
	setLocale(locale: string): void;
}

export interface LayoutEntry {
	owner: string;
	component: Component;
	order: number;
}

export interface PageEntry {
	id: string;
	label: string;
	owner: string;
	order: number;
	/** Set for pages that take over the whole area; two-column pages have none. */
	component: Component | null;
}

export interface BlockEntry extends LayoutEntry {
	page: string;
	column: ColumnName;
}

export interface EntryBlockEntry extends LayoutEntry {
	kind: string;
	types: string[] | null;
}

/** What the layout needs to render; not part of the plugin API. */
export interface GameUi {
	bands: Record<BandName, LayoutEntry[]>;
	pages: PageEntry[];
	blocks: BlockEntry[];
	entryBlocks: EntryBlockEntry[];
	/** The open entry per page id: each page remembers its own. */
	entries: Record<string, Entry | null>;
	page: Ref<string>;
	gate: ShallowRef<Component | null>;
	toast: Ref<{ message: string; kind: 'error' | 'info' } | null>;
}

export const GameKey: InjectionKey<Game> = Symbol('game');
export const GameUiKey: InjectionKey<GameUi> = Symbol('game-ui');

/** Access the game from any component rendered by the client. */
export function useGame(): Game {
	const game = inject(GameKey);
	if (!game) throw new Error('useGame() called outside the game app');
	return game;
}

function sortPlugins(plugins: ClientPlugin[]): ClientPlugin[] {
	const byId = new Map(plugins.map((p) => [p.id, p]));
	const done = new Set<string>();
	const out: ClientPlugin[] = [];
	const visit = (p: ClientPlugin, path: string[]) => {
		if (done.has(p.id)) return;
		if (path.includes(p.id)) throw new Error(`Client plugin cycle: ${[...path, p.id].join(' -> ')}`);
		for (const dep of p.dependsOn ?? []) {
			const d = byId.get(dep);
			if (!d) throw new Error(`Client plugin "${p.id}" needs "${dep}"`);
			visit(d, [...path, p.id]);
		}
		done.add(p.id);
		out.push(p);
	};
	plugins.forEach((p) => visit(p, []));
	return out;
}

/**
 * Resync with the server every `refreshMs` while the tab is visible. Values are interpolated
 * locally in between, so a slow poll is invisible to players and keeps request quotas low.
 */
export async function bootGame(plugins: ClientPlugin[], { refreshMs = 60_000 } = {}): Promise<{ game: Game; ui: GameUi }> {
	const state = shallowRef<ClientState | null>(null);
	const elapsed = ref(0);
	let receivedAt = performance.now();
	const services = new Map<string, unknown>();
	const ui: GameUi = {
		bands: reactive({ top: [], bottom: [] }) as GameUi['bands'],
		pages: reactive([]) as PageEntry[],
		blocks: reactive([]) as BlockEntry[],
		entryBlocks: reactive([]) as EntryBlockEntry[],
		entries: reactive({}),
		page: ref(''),
		gate: shallowRef(null),
		toast: ref(null),
	};
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	const i18n = createI18n();
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeAt: number | null = null;
	const poll = () => game.refresh().catch((err) => err instanceof ApiError || console.error(err));
	const needed = new Set<string>();
	const params = reactive<Record<string, string>>({});
	const query = () => {
		const q = new URLSearchParams(params);
		if (needed.size) q.set('views', [...needed].join(','));
		return q.toString();
	};
	let currentPlugin = 'core';

	const setState = (next: ClientState) => {
		state.value = next;
		receivedAt = performance.now();
		elapsed.value = 0;
	};

	const game: Game = {
		meta: await request<Meta>('/api/meta'),
		state,
		elapsed,
		serverNow: () => (state.value?.now ?? Date.now()) + elapsed.value * 1000,
		view: (id) => state.value?.views[id] as never,
		need: (...ids) => ids.forEach((id) => needed.add(id)),
		params,
		async setParam(name, value) {
			if (value === undefined) delete params[name];
			else params[name] = value;
			await game.refresh();
		},
		request,
		async command(type, payload) {
			try {
				setState(await request<ClientState>(`/api/command?${query()}`, { method: 'POST', body: { type, payload } }));
				return true;
			} catch (err) {
				game.toast(err instanceof Error ? err.message : String(err));
				// The client's picture was probably stale (that's often why it failed): resync.
				poll();
				return false;
			}
		},
		async refresh() {
			setState(await request<ClientState>(`/api/state?${query()}`));
		},
		refreshAt(serverTime) {
			// Keep only the earliest pending wake-up; a small margin lets the server see it as due.
			if (wakeAt !== null && wakeAt <= serverTime) return;
			clearTimeout(wakeTimer);
			wakeAt = serverTime;
			wakeTimer = setTimeout(
				() => {
					wakeAt = null;
					poll();
				},
				Math.max(0, serverTime - game.serverNow()) + 500,
			);
		},
		band(name, component, { order = 0 } = {}) {
			ui.bands[name].push({ owner: currentPlugin, component: markRaw(component), order });
			ui.bands[name].sort((a, b) => a.order - b.order);
		},
		page(id, label, { order = 0, component } = {}) {
			if (ui.pages.some((p) => p.id === id)) throw new Error(`Page "${id}" registered twice`);
			ui.pages.push({ id, label, owner: currentPlugin, component: component ? markRaw(component) : null, order });
			ui.pages.sort((a, b) => a.order - b.order);
			ui.page.value = ui.pages[0].id;
		},
		block(page, column, component, { order = 0 } = {}) {
			ui.blocks.push({ page, column, owner: currentPlugin, component: markRaw(component), order });
			ui.blocks.sort((a, b) => a.order - b.order);
		},
		entryBlock(kind, component, { order = 0, types } = {}) {
			ui.entryBlocks.push({ kind, types: types ?? null, owner: currentPlugin, component: markRaw(component), order });
			ui.entryBlocks.sort((a, b) => a.order - b.order);
		},
		openEntry(entry) {
			ui.entries[ui.page.value] = entry;
		},
		entry: computed(() => ui.entries[ui.page.value] ?? null),
		showPage(id, entry) {
			if (!ui.pages.some((p) => p.id === id)) throw new Error(`No page "${id}"`);
			ui.page.value = id;
			if (entry !== undefined) ui.entries[id] = entry;
		},
		gate(component) {
			ui.gate.value = markRaw(component);
		},
		provide(name, impl) {
			if (services.has(name)) throw new Error(`Client service "${String(name)}" provided twice`);
			services.set(name, impl);
		},
		use(name) {
			if (!services.has(name)) throw new Error(`Client service "${String(name)}" not provided`);
			return services.get(name) as never;
		},
		t: (text, vars) => i18n.t(text, vars),
		messages: (locale, messages) => i18n.add(locale, messages),
		locale: i18n.locale,
		setLocale: (locale) => i18n.setLocale(locale),
		toast(message, kind = 'error') {
			// Messages may come from the server in English: translate like any other text.
			ui.toast.value = { message: i18n.t(message), kind };
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => (ui.toast.value = null), 2500);
		},
	};

	for (const plugin of sortPlugins(plugins)) {
		currentPlugin = plugin.id;
		await plugin.setup(game);
		if (ui.gate.value) return { game, ui };
	}

	await game.refresh();
	setInterval(() => document.visibilityState === 'visible' && poll(), refreshMs);
	// Coming back to the tab: resync at once instead of waiting for the next tick.
	document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
	setInterval(() => (elapsed.value = (performance.now() - receivedAt) / 1000), 100);
	return { game, ui };
}
