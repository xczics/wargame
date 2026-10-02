/**
 * Data shapes of the client's generic widgets (docs/design/architecture.md §3.2). A server plugin
 * declares a widget somewhere (`ui.block` / `slot` / ... with `props.view`) and a view that returns
 * that widget's shape; the client draws it without knowing the plugin. Pure types, both ends use them.
 */

/**
 * Text the client translates: `text` is the English source (a key of the plugins' i18n tables);
 * `vars` fill its `{name}` placeholders, and string values are translated too (numbers the server
 * formats, e.g. "2,795", translate to themselves).
 */
export interface UiText {
	text: string;
	vars?: Record<string, string | number>;
}

/** Widget `ui.badge`: a short line, e.g. next to the user name — a bold label, a value, a tooltip. */
export interface BadgeData {
	label?: UiText;
	value?: UiText;
	title?: UiText;
}

/** A command the player can run from a widget: a button. */
export interface UiAction {
	command: string;
	payload?: Record<string, unknown>;
	label: UiText;
	/** Why it cannot be done now: the button is disabled and shows this. */
	blocked?: UiText;
	/** Asked before running it. */
	confirm?: UiText;
}

/** One card of `ui.cards`. */
export interface UiCard {
	id: string;
	/** Which of the data's `groups` it belongs to (sections and filters). */
	group?: string;
	icon?: string;
	title: UiText;
	/** Colours the title (equipment rarity: white, green, blue, gold, purple). */
	rarity?: string;
	/** Shown as "×n" when above 1. */
	count?: number;
	text?: UiText;
	/** Short status lines, e.g. a price ("warn": shown in red, e.g. not affordable). */
	lines?: { text: UiText; tone?: 'muted' | 'warn' }[];
	actions?: UiAction[];
}

/**
 * Widgets `ui.cards` (the grid, in sections by group) and `ui.filters` (heading, summary lines, a button
 * per group, a note): both read the same view and share the chosen group through `props.filter`.
 */
export interface CardsData {
	title?: UiText;
	summary?: UiText[];
	note?: UiText;
	groups?: { id: string; label: UiText }[];
	cards: UiCard[];
	/** Shown when there are no cards. */
	empty?: UiText;
}

/** One line of `ui.timers`: something under way or waiting. */
export interface UiTimer {
	id: string;
	/** On an entry (e.g. a building), the widget shows only the lines whose `where` is that entry's type. */
	where?: string;
	icon?: string;
	title: UiText;
	/** Server times (ms): a countdown to `endsAt`, and a progress bar when `startedAt` is known too. The client resyncs at `endsAt`. */
	startedAt?: number;
	endsAt?: number;
	lines?: { text: UiText; tone?: 'muted' | 'warn' }[];
	actions?: UiAction[];
}

/** Widget `ui.timers`: a list of things under way (construction, training, marches...). */
export interface TimersData {
	title?: UiText;
	items: UiTimer[];
	/** Notes below the list (`where` as for items, e.g. why nothing can start in this building). */
	notes?: { where?: string; text: UiText; tone?: 'muted' | 'warn' }[];
}

/** One row of `ui.rows`. */
export interface UiRow {
	id: string;
	icon?: string;
	title: UiText;
	/** Next to the title, e.g. "Lv 1/3". */
	badge?: UiText;
	lines?: { text: UiText; tone?: 'muted' | 'warn' }[];
	/** Not available yet (shown faded). */
	locked?: boolean;
	actions?: UiAction[];
}

/** Widget `ui.rows`: lists in sections, e.g. what a building has and what each next step costs. */
export interface RowsData {
	title?: UiText;
	sections: { title?: UiText; rows: UiRow[] }[];
	notes?: { text: UiText; tone?: 'muted' | 'warn' }[];
}
