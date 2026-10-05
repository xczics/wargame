/**
 * A player's view over a static view (`base`; AGENTS.md "what changes and what does not"): how the two are put
 * together, the same for the generic widgets (web/widgets/statics.ts) and the tests. Pure functions.
 */
import { costText, duration, whole } from './format';
import { literal } from './i18n';
import type {
	CardsData,
	RowsData,
	TreeData,
	TreeNode,
	UiAction,
	UiActionPart,
	UiCard,
	UiChoice,
	UiLine,
	UiNeed,
	UiRow,
	UiTableCell,
	UiText,
} from './ui';

const without = (lines: UiLine[] | undefined, hide: string[] | undefined) => {
	const hidden = new Set(hide ?? []);
	return (lines ?? []).filter((l) => !l.tag || !hidden.has(l.tag));
};

type Count = (key: string) => number;
type Template = Partial<Omit<UiCard, 'id'>>;

const builders = new Map<string, (data: unknown, key: string) => Template | undefined>();
/** A builder of templates a static view names (`CardsData.builder`), e.g. "buildings": the same on the server's tests and the client. */
export function defineTemplates(name: string, build: (data: unknown, key: string) => Template | undefined) {
	builders.set(name, build);
}
// Built once per static view (a new version is a new object) and key.
const built = new WeakMap<CardsData, Map<string, Template | undefined>>();
function templateOf(base: CardsData, key: string): Template | undefined {
	const listed = base.templates?.[key];
	if (listed || !base.builder) return listed;
	let cache = built.get(base);
	if (!cache) built.set(base, (cache = new Map()));
	if (!cache.has(key)) cache.set(key, builders.get(base.builder)?.(base.data, key));
	return cache.get(key);
}

/**
 * A button worked out against the counters: price parts short in red (then off with its `short`), times by their
 * factor; `extra`: the card's payload added, and why it is off here (before anything else).
 */
function resolveAction(a: UiAction, count: Count, extra?: { payload?: Record<string, unknown>; blocked?: UiText }): UiAction {
	let short = false;
	const parts = a.parts?.map((p): UiActionPart => {
		if (p.seconds !== undefined) {
			const factor = p.factor ? count(p.factor) || 1 : 1;
			return { text: literal(`· ${duration(Math.max(1, Math.ceil(p.seconds * factor)))}`) };
		}
		if (!p.need) return p;
		const text = p.text ?? { text: costText(p.need.icon ?? '', p.need.amount) };
		if (count(p.need.counter) >= p.need.amount) return { ...p, text };
		short = true;
		return { ...p, text, tone: 'warn' };
	});
	const blocked = extra?.blocked ?? a.blocked ?? shortOf(a.needs, count) ?? (short ? a.short : undefined);
	return {
		...a,
		...(parts ? { parts } : {}),
		...(extra?.payload && a.command ? { payload: { ...a.payload, ...extra.payload } } : {}),
		...(blocked ? { blocked } : {}),
	};
}

const shortOf = (needs: UiNeed[] | undefined, count: Count) => (needs ?? []).find((n) => count(n.counter) < n.amount)?.short;

/**
 * A card's detail choices: its own, or the shared list (`choiceSet`) with its payload added to each action's and the
 * ones it names off (`blockedSet`), each worked out against the counters.
 */
export function expandChoices(data: CardsData, card: UiCard, counter?: (key: string) => number | undefined): UiChoice[] {
	const d = card.detail;
	if (!d) return [];
	const count: Count = (k) => data.counters?.[k] ?? counter?.(k) ?? 0;
	const list = d.choices ?? (d.choiceSet ? (data.choiceSets?.[d.choiceSet] ?? []) : []);
	const off = d.blockedSet ? (data.blockedSets?.[d.blockedSet] ?? {}) : {};
	return list.map((ch) => {
		const blocked = ch.id ? off[ch.id] : undefined;
		return {
			...ch,
			lines: [...(ch.lines ?? []), ...(blocked ? [{ text: blocked, tone: 'warn' as const }] : [])],
			action: resolveAction(ch.action, count, { payload: d.choices ? undefined : d.payload, blocked }),
		};
	});
}

/**
 * Cards: the static ones worked out against the player's counters (what is short, what is used up, lines showing a
 * counter), then its patches (lines, hidden tags, buttons by position), its fields and extra cards; a card of the
 * player's naming a `template` is built from it (its payload added to the template's buttons). Counters: the view's,
 * else `counter` (the client's own, e.g. resources counted on).
 */
export function mergeCards(base: CardsData, d: CardsData, counter?: (key: string) => number | undefined): CardsData {
	const patches = d.patches ?? {};
	const count: Count = (k) => d.counters?.[k] ?? counter?.(k) ?? 0;
	const cards = base.cards.map((c): UiCard => {
		const reached = (c.limits ?? []).find((l) => count(l.counter) >= l.max);
		const short = shortOf(c.needs, count);
		const blocked = reached?.reached ?? short;
		const lines = (c.lines ?? []).map((l) => ({
			...l,
			...(short && l.tag === 'price' ? { tone: 'warn' as const } : {}),
			...(l.counter ? { text: { ...l.text, vars: { ...l.text.vars, n: count(l.counter) } } } : {}),
		}));
		const actions = c.actions?.map((a, i) => resolveAction(a, count, i === 0 && blocked ? { blocked } : undefined));
		const p = patches[c.id];
		const merged: UiCard = {
			...c,
			lines: p ? [...without(lines, p.hide), ...(p.lines ?? [])] : lines,
			...(actions ? { actions: p ? actions.map((a, i) => ({ ...a, ...(p.actions?.[i] ?? {}) })) : actions } : {}),
		};
		if (!c.countFrom) return merged;
		const n = count(c.countFrom);
		const { countFrom: _c, ifNone, ...rest } = merged;
		return { ...rest, count: n, ...(n ? {} : ifNone) };
	});
	const groupPayload = new Map((d.groups ?? []).map((g) => [g.id, g.payload]));
	const own = d.cards.map((c): UiCard => {
		const t = c.template ? (d.templates?.[c.template] ?? templateOf(base, c.template)) : undefined;
		if (!t) return c;
		const { template: _t, payload: mine, blocked, ...rest } = c;
		const payload = { ...d.payload, ...(c.group ? groupPayload.get(c.group) : undefined), ...mine };
		const data = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)]));
		const entry = (a: UiAction): UiAction =>
			a.entry && !a.entry.id ? { ...a, entry: { ...a.entry, id: c.id, data: { ...a.entry.data, ...data } } } : a;
		const detail =
			t.detail || c.detail ? { ...t.detail, ...c.detail, payload: { ...t.detail?.payload, ...payload, ...c.detail?.payload } } : undefined;
		return {
			...t,
			...rest,
			...(t.where ? { where: [t.where].flat().map((w) => w.replace('{id}', c.id)) } : {}),
			...(c.where ? { where: c.where } : {}),
			...(detail ? { detail } : {}),
			lines: [...(t.lines ?? []), ...(c.lines ?? [])],
			actions: [
				...(t.actions ?? []).map((a, i) => entry(resolveAction(a, count, { payload, ...(i === 0 && blocked ? { blocked } : {}) }))),
				...(c.actions ?? []),
			],
		};
	});
	return {
		...base,
		...d,
		cards: [...cards, ...own],
		...(base.choiceSets || d.choiceSets ? { choiceSets: { ...base.choiceSets, ...d.choiceSets } } : {}),
	};
}

/** A table cell worked out against the counters (`counter`, `over`): the same on the client and in tests. */
export function resolveCell(c: UiTableCell, counter: (key: string) => number | undefined): UiTableCell {
	if (c.over && (counter(c.over.counter) ?? 0) >= c.over.amount)
		return { ...c, text: c.over.text, ...(c.over.tone ? { tone: c.over.tone } : {}) };
	if (!c.counter) return c;
	const n = counter(c.counter) ?? 0;
	return { ...c, text: literal(whole(n)), ...(n < 0 ? { tone: 'warn' as const } : {}) };
}

/**
 * Rows: the sections and rows the player's view names (in its order; `allRows`: every static row), with its fields
 * and lines on top, and each row's `needs` worked out against the counters (the view's, else `counter`, the client's).
 */
export function mergeRows(base: RowsData, d: RowsData, counter?: (key: string) => number | undefined): RowsData {
	const count = (k: string) => d.counters?.[k] ?? counter?.(k) ?? 0;
	const needs = (r: UiRow): UiRow => {
		const short = (r.needs ?? []).find((n) => count(n.counter) < n.amount);
		return short && r.actions?.length
			? { ...r, actions: r.actions.map((a, i) => (i === 0 ? { ...a, blocked: a.blocked ?? short.short } : a)) }
			: r;
	};
	const sections = d.sections.map((s) => {
		const from = s.group ? base.sections.find((b) => b.group === s.group) : undefined;
		if (!from) return s;
		const rows = (s.allRows ? from.rows : s.rows).map((r) => {
			const mine = s.allRows ? s.rows.find((x) => x.id === r.id) : r;
			const row = s.allRows ? r : from.rows.find((b) => b.id === r.id);
			if (!row) return needs(r);
			return needs(mine ? { ...row, ...mine, lines: [...without(row.lines, mine.hide), ...(mine.lines ?? [])] } : row);
		});
		return { ...from, ...s, rows, lines: [...(from.lines ?? []), ...(s.lines ?? [])] };
	});
	return { ...base, ...d, sections };
}

/** A tree: the static nodes with the player's part of each (`nodes`), and the nodes it adds (`groups`). */
export function mergeTree(base: TreeData, d: TreeData): TreeData {
	const patch = d.nodes ?? {};
	const node = (n: TreeNode): TreeNode => {
		const p = patch[n.id];
		if (!p) return n;
		const met = new Set(p.met ?? []);
		return {
			...n,
			...(p.badge ? { badge: p.badge } : {}),
			...(p.state ? { state: p.state } : {}),
			...(p.actions ? { actions: p.actions } : {}),
			lines: [...(n.lines ?? []), ...(p.lines ?? [])],
			requires: (n.requires ?? []).map((r) => ({ ...r, met: met.has(r.id) })),
			tags: (n.tags ?? []).map((t) => ({ ...t, met: t.id ? met.has(t.id) : t.met })),
		};
	};
	const groups = base.groups.map((g) => ({ ...g, columns: g.columns.map((c) => ({ ...c, nodes: c.nodes.map(node) })) }));
	for (const g of d.groups) {
		const into = groups.find((x) => x.id === g.id);
		if (!into) groups.push({ ...g, columns: g.columns.map((c) => ({ ...c, nodes: c.nodes.map(node) })) });
		else
			g.columns.forEach((c, i) => {
				if (!into.columns[i]) into.columns[i] = { ...c, nodes: [] };
				into.columns[i].nodes.push(...c.nodes.map(node));
			});
	}
	return { ...base, ...d, groups };
}
