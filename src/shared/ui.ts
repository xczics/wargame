/**
 * Data shapes of the client's generic widgets (docs/design/ui.md §3). A server plugin
 * declares a widget somewhere (`ui.block` / `slot` / ... with `props.view`) and a view that returns
 * that widget's shape; the client draws it without knowing the plugin. Pure types, both ends use them.
 */

/**
 * Text the client translates: `text` is the English source (a key of the plugins' i18n tables);
 * `vars` fill its `{name}` placeholders, and string values are translated too (numbers the server
 * formats, e.g. "2,795", translate to themselves).
 */
/**
 * A text to show: `text` is always a full i18n key ("<pluginId>.<key>", made by `uiTexts` / `keyText`, see
 * src/shared/i18n.ts); its placeholders are filled from `vars`. A var that is a UiText is translated, a list
 * of them item by item and joined (", "); a string is shown as it is (people's name-part keys spelled).
 */
export interface UiText {
	text: string;
	vars?: Record<string, string | number | UiText | UiText[]>;
}

/** Widget `ui.badge`: a short line, e.g. next to the user name — a bold label, a value, a tooltip. */
export interface BadgeData {
	label?: UiText;
	value?: UiText;
	title?: UiText;
}

/** A status line: muted, or "warn" (red); with `endsAt` (server ms) a countdown follows it. */
export interface UiLine {
	text: UiText;
	/** "info": an effect (e.g. what a building gives). */
	tone?: 'muted' | 'warn' | 'info';
	endsAt?: number;
	/** With `endsAt`: a progress bar from here. */
	startedAt?: number;
	/** Colours the text (equipment rarity). */
	rarity?: string;
	/** Details shown on hover, a line each (e.g. the sources of a limit); the line is marked as having them. */
	hint?: UiText[];
	/** Parts after the text, each in its own colour (e.g. possible drops). */
	parts?: { text: UiText; rarity?: string }[];
}

/** A button: runs a player command, or (with `page`) opens a page of the client, or (with `params`) changes the client's parameters (e.g. the selected settlement). */
export interface UiAction {
	command?: string;
	/** Instead of a command: open this page (e.g. "mail"). */
	page?: string;
	/** Instead of a command: set these client parameters (e.g. { settlement: "<id>" }). */
	params?: Record<string, string>;
	/** Instead of a command: open an entry in the right column (e.g. a building), as the client's openEntry. */
	entry?: { kind: string; id: string; type?: string; label: UiText; data?: Record<string, string> };
	payload?: Record<string, unknown>;
	label: UiText;
	/** Shown after the label, e.g. a price: each part on its own, "warn" in red (a resource that is short). */
	parts?: { text: UiText; tone?: 'warn' }[];
	/** Why it cannot be done now: the button is disabled and shows this. */
	blocked?: UiText;
	/** Asked before running it. */
	confirm?: UiText;
	/** Details shown on hover, a line each (e.g. where its time or cost comes from). */
	hint?: UiText[];
	/** Shown over the whole screen when the command succeeded, until the player closes it (purchases and the like). */
	notice?: UiText;
	/** Shown at once while its command runs, e.g. "Buying…" (default: "<label>: working…"). */
	pending?: UiText;
}

/** One card of `ui.cards`. */
export interface UiCard {
	id: string;
	/**
	 * Where it shows: on an entry "<kind>:<type>" (e.g. "building:barracks") or "<kind>#<entry id>" (that one
	 * entry), on a page "page:<id>"; several places as a list; absent: everywhere.
	 */
	where?: string | string[];
	/** Which of the data's `groups` it belongs to (sections and filters). */
	group?: string;
	icon?: string;
	title: UiText;
	/** Colours the title (equipment rarity: white, green, blue, gold, purple). */
	rarity?: string;
	/** Shown as "×n" when above 1. */
	count?: number;
	/** Right of the title (layout "nodes"), e.g. "Lv 2/5". */
	badge?: UiText;
	/** A line in italics under the title (layout "nodes"), e.g. a tech's motto. */
	quote?: UiText;
	text?: UiText;
	/** Short status lines, e.g. a price ("warn": shown in red, e.g. not affordable). */
	lines?: UiLine[];
	actions?: UiAction[];
	/** Clicking the card opens this in place of the grid (with a way back): more text and a server form (command form at `placement`). */
	detail?: {
		/** The button opening it (default "Open"). */
		label?: UiText;
		lines?: UiText[];
		/** Server forms: those of `command` at `placement` (all of them without one), with `context` added to the params (e.g. { hero }). */
		form?: { placement: string; command?: string; context?: Record<string, string> };
		/** Choices, each a button with its own lines (e.g. what can be built in an empty slot). */
		choices?: { lines?: UiLine[]; action: UiAction }[];
	};
}

/**
 * Widgets `ui.cards` (the grid, in sections by group) and `ui.filters` (heading, summary lines, a button
 * per group, a note): both read the same view and share the chosen group through `props.filter`.
 */
export interface CardsData {
	title?: UiText;
	/** Heading of the grid in the tiles layout when no group is chosen (e.g. "All items"). */
	allTitle?: UiText;
	/** Shown above the cards by `ui.cards` (e.g. the settlement's name and limits). */
	header?: { title: UiText; lines?: UiLine[] };
	/** The group shown while none is chosen (instead of all). */
	defaultGroup?: string;
	/** Server forms of this placement shown below the cards (e.g. renaming the settlement). */
	placement?: string;
	summary?: UiText[];
	note?: UiText;
	/** `lines`: under the group's heading in `ui.cards` (e.g. when it is renewed, with a countdown). */
	groups?: { id: string; label: UiText; lines?: UiLine[] }[];
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
	lines?: UiLine[];
	actions?: UiAction[];
}

/** Widget `ui.timers`: a list of things under way (construction, training, marches...). */
export interface TimersData {
	title?: UiText;
	/** "warn": the block stands out (e.g. incoming attacks). */
	tone?: 'warn';
	items: UiTimer[];
	/** Notes below the list (`where` as for items, e.g. why nothing can start in this building). */
	notes?: (UiLine & { where?: string })[];
}

/** One row of `ui.rows`. */
export interface UiRow {
	id: string;
	icon?: string;
	title: UiText;
	/** Colours the title (equipment rarity). */
	rarity?: string;
	/** Next to the title, e.g. "Lv 1/3". */
	badge?: UiText;
	lines?: UiLine[];
	/** Not available yet (shown faded). */
	locked?: boolean;
	actions?: UiAction[];
}

/** One cell of `ui.table`: its text, in red ("warn") or muted, with details on hover. */
export interface UiTableCell {
	text: UiText;
	tone?: 'muted' | 'warn' | 'info';
	hint?: UiText[];
}

/** Widget `ui.table`: a small table, e.g. a settlement's production by resource. The first cell of a row is its label. */
export interface TableData {
	title?: UiText;
	columns: UiText[];
	rows: { id: string; cells: UiTableCell[] }[];
	/** Lines under the table. */
	lines?: UiLine[];
}

/** Widget `ui.rows`: lists in sections, e.g. what a building has and what each next step costs. */
export interface RowsData {
	title?: UiText;
	/**
	 * `actions` sit next to the section's title; `lines` below its rows; `current` marks it (e.g. the selected
	 * settlement); `where` as for `ui.timers` (on an entry, only sections without one or for that entry's type).
	 */
	sections: {
		title?: UiText;
		/** Lines under the title, before the rows. */
		intro?: UiLine[];
		/** Shown only while this group is chosen (see `tabs`); sections without one always show. */
		group?: string;
		where?: string;
		rows: UiRow[];
		/** A row of small cells after the rows (e.g. accessory slots), as in `ui.cells`. */
		cells?: UiCellItem[];
		lines?: UiLine[];
		actions?: UiAction[];
		current?: boolean;
	}[];
	notes?: UiLine[];
	/** A drop-down above the sections that sets a client parameter (e.g. which hero), so the view follows it. */
	picker?: UiPicker;
	/**
	 * A button per group above the sections (e.g. one per realm). The chosen group is shared with the widgets of
	 * the same `filter` (they show their sections of that group too, without buttons of their own).
	 */
	tabs?: { id: string; label: UiText }[];
	/** The group shown while none is chosen (or the chosen one is not in this data). */
	defaultTab?: string;
}

/** A choice of a client parameter: `options` to pick from, `selected` the one the view shows. */
export interface UiPicker {
	param: string;
	options: { value: string; label: UiText }[];
	selected: string;
}

/** One cell of `ui.grid`. */
export interface GridCell {
	x: number;
	y: number;
	/** Background: a colour token of the client's styles, without "--" (e.g. "terrain-forest"). */
	fill?: string;
	icon?: string;
	/** Border: "mine" (accent), "enemy" (danger), "marked" (info), "occupied" (muted). */
	tone?: 'mine' | 'enemy' | 'marked' | 'occupied';
	/** Tooltip parts (joined). */
	title?: UiText[];
	/** Shown when the cell is selected, with its buttons. */
	info?: UiLine[];
	actions?: UiAction[];
}

/**
 * Widget `ui.grid`: a window of a grid map around `centre` (every cell within `radius`). The grid is
 * `width` x `height` from (`minX`, `minY`); `y` grows upwards (the top row is the highest y); with
 * `wrap` its edges meet. The widget asks the view again with `x`, `y`, `r` when the player moves.
 * Selecting a cell shows its info and the server forms of `placement` (their params get x and y).
 */
export interface GridData {
	title?: UiText;
	minX: number;
	minY: number;
	width: number;
	height: number;
	wrap: boolean;
	centre: { x: number; y: number };
	radius: number;
	/** Where "home" goes (e.g. the selected settlement). */
	home?: { x: number; y: number };
	cells: GridCell[];
	legend?: { fill: string; label: UiText }[];
	placement?: string;
	/** Lists beside the grid, worked out for this window (e.g. NPC settlements around its centre). */
	sides?: GridSide[];
}

/**
 * A list beside `ui.grid`: picking an item centres the grid on it and selects that cell. `choice` is a
 * drop-down whose value travels with the next request as parameter `param` (e.g. how far to look).
 */
export interface GridSide {
	title: UiText;
	notes?: UiLine[];
	choice?: { param: string; options: { value: string; label: UiText }[]; selected: string };
	items: { label: UiText; sub?: UiText[]; at: { x: number; y: number } }[];
	empty?: UiText;
}

/** One node of `ui.tree`. */
export interface TreeNode {
	id: string;
	title: UiText;
	badge?: UiText;
	quote?: UiText;
	lines?: UiLine[];
	/** How it is drawn: "done" (finished), "active" (under way), "locked" (faded), "started", "open". */
	state?: 'done' | 'active' | 'locked' | 'started' | 'open';
	/** Prerequisites in the same group: a line from each (highlighted when met). */
	requires?: { id: string; met: boolean }[];
	/** Prerequisites elsewhere: tags. */
	tags?: { text: UiText; met: boolean }[];
	actions?: UiAction[];
}

/** Widget `ui.tree`: groups (e.g. branches) of columns (e.g. tiers) of nodes, with lines to what they need. */
export interface TreeData {
	title?: UiText;
	groups: { id: string; label?: UiText; columns: { label?: UiText; nodes: TreeNode[] }[] }[];
	notes?: UiLine[];
}

/** One cell of `ui.cells`. */
export interface UiCellItem {
	id: string;
	/** Big text in the cell (e.g. "Inner", "3", "＋"). */
	label?: UiText;
	sub?: UiText;
	/** Small text at the bottom (e.g. the terrain). */
	note?: UiText;
	/** Tooltip. */
	title?: UiText;
	/** Look: "strong" (bold border), "solid", "add" (dashed accent, e.g. a place to build), "muted". */
	tone?: 'strong' | 'solid' | 'add' | 'muted';
	/** Colours the label (equipment rarity). */
	rarity?: string;
	/** Selecting it shares its id with the widgets of the same `filter` (e.g. the cards of that district). */
	selectable?: boolean;
	/** Clicking it runs this instead. */
	action?: UiAction;
}

/** Widget `ui.cells`: a small board of cells (row by row, null = no cell), e.g. a settlement's districts where they lie. */
export interface CellsData {
	title?: UiText;
	columns: number;
	cells: (UiCellItem | null)[];
	/** The cell selected while none is chosen. */
	defaultSelected?: string;
}

/** A label and its value, e.g. "Loot: 🪨100"; the value's parts follow one another, each with its own colour. */
export interface UiField {
	label: UiText;
	value: { text: UiText; rarity?: string; tone?: 'muted' | 'warn' | 'info' }[];
}

/**
 * Widget `ui.lanes`: a side-by-side account row by row, e.g. a battle lane by lane (each row a lane, a column
 * per side); "good" / "bad" colours a row's label (won / lost).
 */
export interface LanesData {
	title?: UiText;
	summary?: UiLine[];
	columns: UiText[];
	rows: { label: UiText; tone?: 'good' | 'bad'; cells: UiLine[][] }[];
	notes?: UiLine[];
}

/**
 * Widget `ui.report`: a report, e.g. a mail (the mail plugin's presenters fill `report` in its messages):
 * a badge and lines, label-value fields, a lane-by-lane account, notes; "good" / "bad" colours its edge.
 */
export interface ReportData {
	tone?: 'good' | 'bad';
	badge?: UiText;
	lines?: UiLine[];
	fields?: UiField[];
	lanes?: LanesData;
	notes?: UiLine[];
}

/**
 * Form field widget `ui.lanes-input` (a field of type "widget"): sharing a pool over lanes, e.g. an army's
 * formation. Each lane picks a group (e.g. a unit family) and takes counts of that group's options; options of
 * no group go in an extra box. Each box shows how many are still free: the pool (picked by the value of the
 * form field `poolField`, e.g. the origin's garrison) minus what the other boxes hold.
 */
export interface LanesInputData {
	title?: UiText;
	lanes: number;
	/** Heading of each lane, with {0} = its number. */
	laneLabel: UiText;
	groups: { id: string; label: UiText }[];
	/** Shown in ascending `order` within a lane. */
	options: { id: string; label: UiText; group: string | null; order?: number }[];
	poolField: string;
	pools: Record<string, Record<string, number>>;
	/** Payload: `{ [lanes]: [{ [group]: id, [counts]: { option: n } }], [total]: { option: n } }` (total: lanes and extra box). */
	output: { lanes: string; group: string; counts: string; total: string };
	/** The box for options of no group. */
	extra?: { title: UiText; note?: UiText };
	/** Shown in a lane whose group has nothing in the pool. */
	emptyLane?: UiText;
	/** Below, with {0} = how many in the lanes, {1} = in the extra box. */
	summary?: UiText;
}

/**
 * Widget `ui.sync` (nothing to see; put it in a band): at each `at` (server ms) the client refreshes, or runs
 * `command` when given (e.g. commit an army's arrival at once, so its report is in the mailbox right away).
 * Commands already due when the page loads run once at load.
 */
export interface SyncData {
	items: { at: number; command?: string; payload?: Record<string, unknown> }[];
}

/** Widget `ui.banner`: a notice across the page (e.g. the GM's announcement); a player can hide it until `key` changes. */
export interface BannerData {
	text: UiText;
	icon?: string;
	key: string;
}
