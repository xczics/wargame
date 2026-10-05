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
import {
	computed,
	inject,
	markRaw,
	reactive,
	ref,
	shallowRef,
	watch,
	type Component,
	type InjectionKey,
	type Ref,
	type ShallowRef,
} from 'vue';
import type { ClientState, Meta, UiProps, ViewMap } from '../../src/shared/api';
import type { UiText } from '../../src/shared/ui';
import { ApiError, errorText, holdMeta, loadMeta, request } from './api';
import { createI18n, type Messages } from './i18n';
import { frameMessages } from './messages';

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
	/** Heading above the blocks. */
	label: string | UiText;
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
	/**
	 * A static view (`ctx.statics`: what does not depend on the player), fetched once per version and kept; undefined
	 * until it arrives. Reactive: a new version (a GM change, a deploy) is fetched when the state says so.
	 */
	static<T = unknown>(id: string): T | undefined;
	/** Numbers the client knows itself, for static views' `needs` (e.g. "resource:gold", counted on between syncs). */
	provideCounter(prefix: string, count: (rest: string) => number | undefined): void;
	counter(key: string): number | undefined;
	/** Ask for a view to be included in every state sync (call during setup). */
	need(...ids: (keyof ViewMap | string)[]): void;
	/**
	 * Fetch a view only while it can be seen: on a page (or every page), or in an entry of a kind (and types).
	 * Switching page or entry fetches at once; what other pages showed stays until they are seen again.
	 */
	needWhere(id: string, where: { page: string } | { entry: { kind: string; types?: string[] } }): void;
	/**
	 * While shown, have `view` computed again with these parameters in every sync and command (e.g. a form
	 * area's forms), read from `state.instances[key]`; one request answers for the whole screen. Returns the
	 * function to stop. A new key fetches at once (one request for everything added in the same tick).
	 */
	instance(key: string, view: string, params: Record<string, string>): () => void;
	/** Parameters sent with every sync and command (e.g. `settlement`). Setting one resyncs. */
	readonly params: Readonly<Record<string, string>>;
	setParam(name: string, value: string | undefined): Promise<void>;
	request: typeof request;
	/**
	 * Run a player command; shows a toast and resolves false on failure. With `pending` (something the player
	 * asked for, e.g. "Buying…"), that shows at once until the server answers, then a short "Done" (unless
	 * `done: false`, e.g. a notice follows). Background commands pass nothing and stay quiet.
	 */
	command(type: string, payload?: unknown, feedback?: { pending: string | UiText; done?: boolean }): Promise<boolean>;
	refresh(): Promise<void>;
	/** Resync once the server clock reaches `serverTime` (ms), e.g. when a construction finishes. */
	refreshAt(serverTime: number): void;
	/** Render `component` in a fixed band. Lower `order` renders first. */
	band(name: BandName, component: Component, options?: { order?: number; props?: UiProps }): void;
	/**
	 * Add a page tab. Without `component` the page is two columns filled by `block()`;
	 * with it, the component takes over the whole area between the bands (maps, consoles).
	 */
	/** `tab: false`: no tab in the top band; the page is opened some other way (an icon, a badge: `showPage`). */
	page(id: string, label: string, options?: { order?: number; component?: Component; tab?: boolean; props?: UiProps }): void;
	/**
	 * Put a block in a column of a page (`EVERY_PAGE` for all two-column pages). Blocks stack
	 * top to bottom by `order`; the page may be registered by another plugin, before or after.
	 */
	block(page: string, column: ColumnName, component: Component, options?: { order?: number; props?: UiProps }): void;
	/**
	 * Show `component` (it receives the entry as prop `entry`) whenever an entry of `kind` is
	 * open; `types` limits it to some entry types. The plugin that owns the kind puts its own
	 * summary first with a low `order`; others default to 0 and stack below.
	 */
	entryBlock(kind: string, component: Component, options?: { order?: number; types?: string[]; props?: UiProps }): void;
	/** Switch to a page (e.g. from a notification in a band); `entry` also opens an entry there. */
	showPage(id: string, entry?: Entry | null): void;
	/** Open an entry in the right column of the current page; null goes back to the page. */
	openEntry(entry: Entry | null): void;
	/** The entry open on the current page, if any. Reactive. */
	readonly entry: Readonly<Ref<Entry | null>>;
	/** The page shown now. Reactive. */
	readonly currentPage: Readonly<Ref<string>>;
	/**
	 * Make `component` available under `name` (`<plugin>.<name>`): the server's layout (meta `ui`)
	 * says where it goes — a page, a column, an entry, a band, a slot, a kind of mail.
	 */
	widget(name: string, component: Component): void;
	/** The widget registered under `name`, if any (e.g. a mail renderer named by the server). */
	widgetOf(name: string): Component | undefined;
	/** Widgets the server put in the named slot of another widget (e.g. "user-actions"), in order, with their props. */
	slot(name: string): SlotEntry[];
	/** Replace the whole UI with `component` (e.g. a login screen) and stop booting further plugins. */
	gate(component: Component): void;
	provide<K extends keyof ClientServiceMap>(name: K, impl: ClientServiceMap[K]): void;
	use<K extends keyof ClientServiceMap>(name: K): ClientServiceMap[K];
	toast(message: string | UiText, kind?: 'error' | 'info'): void;
	/** A message over the whole screen that stays until the player closes it (a purchase went through...). */
	notice(message: string | UiText): void;
	/**
	 * Translate a text into the current locale: this client plugin's own words (`messages`) first, then the
	 * server's keys and the frame's words. Reactive in templates.
	 */
	t(text: string | UiText, vars?: Record<string, string | number>): string;
	/** Whether a key has a translation of its own (e.g. "<pluginId>.rule:<key>"), so a fallback can be shown instead. */
	hasText(key: string): boolean;
	/**
	 * Register translations of this client plugin's own words (English text -> translation) for a locale. They
	 * are this plugin's keys ("@<plugin>.<text>"): another plugin's words never clash with them.
	 */
	messages(locale: string, messages: Messages): void;
	readonly locale: Readonly<Ref<string>>;
	setLocale(locale: string): void;
}

export interface LayoutEntry {
	owner: string;
	component: Component;
	order: number;
	/** What the server's declaration hands the widget (bound as props). */
	props?: UiProps;
}

export interface SlotEntry {
	component: Component;
	props?: UiProps;
}

export interface PageEntry {
	id: string;
	label: string;
	owner: string;
	order: number;
	/** Set for pages that take over the whole area; two-column pages have none. */
	component: Component | null;
	props?: UiProps;
	/** Shown as a tab in the top band. */
	tab: boolean;
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
	notice: Ref<string | null>;
	/** What the player is waiting for now ("Buying…"), while a command they asked for runs. */
	pending: Ref<string | null>;
}

export const GameKey: InjectionKey<Game> = Symbol('game');
export const GameUiKey: InjectionKey<GameUi> = Symbol('game-ui');

/**
 * Access the game from a component of client plugin `plugin` (its `t` finds that plugin's words first). A
 * component names its plugin itself: components travel between plugins (services, slots), so where one is
 * rendered does not say whose words it shows. Without `plugin`: the core's (the frame).
 */
export function useGame(plugin?: string): Game {
	const game = inject(GameKey);
	if (!game) throw new Error('useGame() called outside the game app');
	return plugin ? scopedGames.get(game)!(plugin) : game;
}
/** Per app: the game of each client plugin. */
const scopedGames = new WeakMap<Game, (plugin: string) => Game>();

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
		notice: ref(null),
		pending: ref(null),
	};
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	const i18n = createI18n();
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeAt: number | null = null;
	const poll = () => game.refresh().catch((err) => err instanceof ApiError || console.error(err));
	/** Views fetched in every sync; and views fetched only where they can be seen (`needWhere`). */
	const needed = new Set<string>();
	const viewsWhere: { id: string; page?: string; entry?: { kind: string; types?: string[] } }[] = [];
	/** What the page shown now (and its open entry) needs, besides the views needed everywhere. */
	const viewsNow = () => {
		const out = new Set(needed);
		const page = ui.page.value;
		const entry = ui.entries[page] ?? null;
		for (const s of viewsWhere) {
			if (s.page !== undefined && (s.page === page || s.page === EVERY_PAGE)) out.add(s.id);
			if (s.entry && entry && entry.kind === s.entry.kind && (!s.entry.types || (!!entry.type && s.entry.types.includes(entry.type))))
				out.add(s.id);
		}
		return out;
	};
	const params = reactive<Record<string, string>>({});
	/** Shown instances by key, with how many places show each (form areas asking the same share one). */
	const instances = new Map<string, { view: string; params: Record<string, string>; users: number }>();
	let instanceFetch: ReturnType<typeof setTimeout> | undefined;
	let refreshing: Promise<void> | null = null;
	let refreshAgain: Promise<void> | null = null;
	const query = () => {
		const q = new URLSearchParams(params);
		const views = viewsNow();
		if (views.size) q.set('views', [...views].join(','));
		if (instances.size) q.set('instances', JSON.stringify([...instances].map(([key, i]) => ({ key, view: i.view, params: i.params }))));
		// Views with a stamp it holds: left out while unchanged (e.g. the resource pool, counted on here meanwhile).
		const stamps = state.value?.stamps;
		if (stamps && Object.keys(stamps).length) q.set('stamps', JSON.stringify(stamps));
		return q.toString();
	};
	let currentPlugin = 'core';
	const widgets = new Map<string, { component: Component; owner: string }>();
	const slots = reactive<Record<string, SlotEntry[]>>({});

	const counterProviders = new Map<string, (rest: string) => number | undefined>();
	// Static views by "<id>/<version>": fetched once each (the browser keeps them too).
	const statics = new Map<string, unknown>();
	const fetchingStatics = new Set<string>();
	const staticsTick = ref(0);
	const setState = (next: ClientState) => {
		holdMeta(next.metaVersion);
		// Views of pages not shown now were not asked for: they keep what they last had until seen again.
		state.value = {
			...next,
			views: { ...(state.value?.views ?? {}), ...next.views },
			instances: { ...(state.value?.instances ?? {}), ...(next.instances ?? {}) },
			stamps: { ...(state.value?.stamps ?? {}), ...(next.stamps ?? {}) },
		};
		receivedAt = performance.now();
		elapsed.value = 0;
	};

	const game: Game = {
		meta: await loadMeta<Meta>(),
		state,
		elapsed,
		serverNow: () => (state.value?.now ?? Date.now()) + elapsed.value * 1000,
		view: (id) => state.value?.views[id] as never,
		provideCounter(prefix, count) {
			counterProviders.set(prefix, count);
		},
		counter(key) {
			for (const [prefix, count] of counterProviders) if (key.startsWith(prefix)) return count(key.slice(prefix.length));
			return undefined;
		},
		static<T>(id: string) {
			const version = state.value?.statics?.[id];
			if (!version) return undefined;
			const key = `${id}/${version}`;
			if (!statics.has(key) && !fetchingStatics.has(key)) {
				fetchingStatics.add(key);
				void request<unknown>(`/api/static/${encodeURIComponent(id)}/${encodeURIComponent(version)}`)
					.then((body) => (statics.set(key, body), (staticsTick.value += 1)))
					.catch(() => {})
					.finally(() => fetchingStatics.delete(key));
			}
			void staticsTick.value; // re-run once it arrives
			return statics.get(key) as T | undefined;
		},
		need: (...ids) => ids.forEach((id) => needed.add(id)),
		needWhere: (id, where) => void viewsWhere.push({ id, ...where }),
		instance(key, view, params) {
			const known = instances.get(key);
			if (known) known.users++;
			else {
				instances.set(key, { view, params, users: 1 });
				// Not in the last sync: fetch once for everything shown in this tick.
				if (!(key in (state.value?.instances ?? {}))) {
					clearTimeout(instanceFetch);
					instanceFetch = setTimeout(() => poll(), 0);
				}
			}
			let stopped = false;
			return () => {
				if (stopped) return;
				stopped = true;
				const i = instances.get(key);
				if (i && --i.users <= 0) instances.delete(key);
			};
		},
		params,
		async setParam(name, value) {
			if (value === undefined) delete params[name];
			else params[name] = value;
			await game.refresh();
		},
		request,
		async command(type, payload, feedback) {
			// Shown at once, so a slow answer never looks like a click that did nothing.
			const waiting = feedback ? (typeof feedback.pending === 'string' ? i18n.t(feedback.pending) : i18n.text(feedback.pending)) : null;
			if (waiting) ui.pending.value = waiting;
			try {
				setState(await request<ClientState>(`/api/command?${query()}`, { method: 'POST', body: { type, payload } }));
				if (feedback && feedback.done !== false) game.toast('Done', 'info');
				return true;
			} catch (err) {
				game.toast(errorText(err));
				// The client's picture was probably stale (that's often why it failed): resync.
				poll();
				return false;
			} finally {
				if (waiting && ui.pending.value === waiting) ui.pending.value = null;
			}
		},
		refresh() {
			// One request at a time: asked again while one runs (forms appearing, a page switch), one more after it, for all.
			if (!refreshing) {
				refreshing = request<ClientState>(`/api/state?${query()}`)
					.then(setState)
					.finally(() => (refreshing = null));
				return refreshing;
			}
			refreshAgain ??= refreshing
				.catch(() => {})
				.then(() => {
					refreshAgain = null;
					return game.refresh();
				});
			return refreshAgain;
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
		band(name, component, { order = 0, props } = {}) {
			ui.bands[name].push({ owner: currentPlugin, component: markRaw(component), order, props });
			ui.bands[name].sort((a, b) => a.order - b.order);
		},
		page(id, label, { order = 0, component, tab = true, props } = {}) {
			if (ui.pages.some((p) => p.id === id)) throw new Error(`Page "${id}" registered twice`);
			ui.pages.push({ id, label, owner: currentPlugin, component: component ? markRaw(component) : null, order, tab, props });
			ui.pages.sort((a, b) => a.order - b.order);
			ui.page.value = (ui.pages.find((p) => p.tab) ?? ui.pages[0]).id;
		},
		block(page, column, component, { order = 0, props } = {}) {
			ui.blocks.push({ page, column, owner: currentPlugin, component: markRaw(component), order, props });
			ui.blocks.sort((a, b) => a.order - b.order);
		},
		entryBlock(kind, component, { order = 0, types, props } = {}) {
			ui.entryBlocks.push({ kind, types: types ?? null, owner: currentPlugin, component: markRaw(component), order, props });
			ui.entryBlocks.sort((a, b) => a.order - b.order);
		},
		openEntry(entry) {
			ui.entries[ui.page.value] = entry;
		},
		entry: computed(() => ui.entries[ui.page.value] ?? null),
		currentPage: computed(() => ui.page.value),
		showPage(id, entry) {
			if (!ui.pages.some((p) => p.id === id)) throw new Error(`No page "${id}"`);
			ui.page.value = id;
			if (entry !== undefined) ui.entries[id] = entry;
		},
		widget(name, component) {
			if (widgets.has(name)) throw new Error(`Widget "${name}" registered twice`);
			widgets.set(name, { component: markRaw(component), owner: currentPlugin });
		},
		widgetOf: (name) => widgets.get(name)?.component,
		slot: (name) => slots[name] ?? [],
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
		t: (text, vars) => (typeof text === 'string' ? i18n.t(text, vars) : i18n.text(text)),
		hasText: (key) => i18n.has(key),
		messages: (locale, messages) => i18n.add(locale, messages),
		locale: i18n.locale,
		setLocale: (locale) => i18n.setLocale(locale),
		toast(message, kind = 'error') {
			ui.toast.value = { message: typeof message === 'string' ? i18n.t(message) : i18n.text(message), kind };
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => (ui.toast.value = null), 2500);
		},
		notice(message) {
			ui.notice.value = typeof message === 'string' ? i18n.t(message) : i18n.text(message);
		},
	};

	// The game as client plugin `plugin` sees it: its own words first.
	const scoped = new Map<string, Game>();
	scopedGames.set(game, (plugin) => {
		let g = scoped.get(plugin);
		if (!g) {
			g = Object.create(game) as Game;
			Object.assign(g, {
				t: (text: string | UiText, vars?: Record<string, string | number>) =>
					typeof text === 'string' ? i18n.t(text, vars, plugin) : i18n.text(text, plugin),
				hasText: (key: string) => i18n.has(key, plugin),
				messages: (locale: string, messages: Messages) => i18n.add(locale, messages, plugin),
				toast: (message: string | UiText, kind?: 'error' | 'info') =>
					game.toast(typeof message === 'string' ? i18n.t(message, undefined, plugin) : i18n.text(message, plugin), kind),
				notice: (message: string | UiText) =>
					game.notice(typeof message === 'string' ? i18n.t(message, undefined, plugin) : i18n.text(message, plugin)),
			});
			scoped.set(plugin, g);
		}
		return g;
	});

	// The server plugins' words (their content and messages, "<pluginId>.<key>") and the frame's; client
	// plugins add their own.
	for (const [locale, messages] of Object.entries(game.meta.i18n ?? {})) i18n.add(locale, messages);
	for (const [locale, messages] of Object.entries(frameMessages)) i18n.add(locale, messages, 'core');
	i18n.setNames(game.meta.heroNames ?? {});
	const pluginIds = new Set((game.meta.plugins ?? []).map((p) => p.id));
	i18n.setNamespaces([...pluginIds]);
	for (const plugin of sortPlugins(plugins)) {
		currentPlugin = plugin.id;
		await plugin.setup(scopedGames.get(game)!(plugin.id));
		if (ui.gate.value) return { game, ui };
	}
	layOut(game, widgets, slots);

	// The first sync once the page is mounted and its form areas have registered (the same timer as theirs): one request.
	instanceFetch = setTimeout(() => poll(), 0);
	// Another page or entry: fetch what it shows now (only what is seen is fetched in a sync).
	watch(
		() => `${ui.page.value}|${JSON.stringify(ui.entries[ui.page.value] ?? null)}`,
		() => poll(),
	);
	setInterval(() => document.visibilityState === 'visible' && poll(), refreshMs);
	// Coming back to the tab: resync at once instead of waiting for the next tick.
	document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
	setInterval(() => (elapsed.value = (performance.now() - receivedAt) / 1000), 100);
	return { game, ui };
}

/**
 * Place the widgets where the server's layout says (meta `ui`). A widget the client lacks is
 * skipped: e.g. the GM console registers its widgets only for the GM.
 */
function layOut(game: Game, widgets: Map<string, { component: Component; owner: string }>, slots: Record<string, SlotEntry[]>) {
	const layout = game.meta.ui;
	if (!layout) return;
	// A widget reading a view (props.view) gets it in the syncs while it can be seen: bands and slots always,
	// blocks with their page, entry widgets with entries of their kind.
	type Where = Parameters<Game['needWhere']>[1] | 'always';
	const get = (name: string, props: UiProps | undefined, where: Where) => {
		const c = widgets.get(name)?.component;
		if (c && typeof props?.view === 'string') {
			if (where === 'always') game.need(props.view);
			else game.needWhere(props.view, where);
		}
		return c;
	};
	for (const p of layout.pages) {
		if (p.widget && !get(p.widget, p.props, { page: p.id })) continue;
		game.page(p.id, p.label, {
			order: p.order,
			tab: p.tab,
			props: p.props,
			...(p.widget ? { component: widgets.get(p.widget)?.component } : {}),
		});
	}
	for (const b of layout.blocks) {
		const c = get(b.widget, b.props, { page: b.page });
		if (c) game.block(b.page, b.column, c, { order: b.order, props: b.props });
	}
	for (const e of layout.entries) {
		const c = get(e.widget, e.props, { entry: { kind: e.kind, ...(e.types ? { types: e.types } : {}) } });
		if (c && (!e.types || e.types.length))
			game.entryBlock(e.kind, c, { order: e.order, props: e.props, ...(e.types ? { types: e.types } : {}) });
	}
	for (const b of layout.bands) {
		const c = get(b.widget, b.props, 'always');
		if (c) game.band(b.band, c, { order: b.order, props: b.props });
	}
	for (const s of [...layout.slots].sort((a, b) => a.order - b.order)) {
		const c = get(s.widget, s.props, 'always');
		if (c) slots[s.slot] = [...(slots[s.slot] ?? []), { component: c, props: s.props }];
	}
}
