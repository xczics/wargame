/**
 * The tech tree's math and wording both ends use (AGENTS.md: the server sends data, the browser assembles the display):
 * a tech's quote at any level, the lines of its effects and unlocks, and the tree's layout. The server quotes with it
 * and bakes the static tree (`research.techs`, whose `data` is a `ResearchCatalog`); the client builds the player's
 * tree, cards and timers with it from the view `research.state`. Pure functions.
 */
import { signed } from './format';
import { keyText, literal, uiTexts } from './i18n';
import { planRow, type PlanRow } from './levels';
import type { TreeData, TreeNode, UiText } from './ui';

const text = uiTexts('research');

/** What a tech does per level, for display (e.g. { target: "battle.attack", value: 3, percent: true }). */
export interface TechEffect {
	/** What it changes: a stat id, or a describer's own key (translated on the client as `effect:<target>`). */
	target: string;
	value: number;
	percent: boolean;
	/** Limited to one unit family, if any. */
	family?: string;
	/** That family's name, for the text (the describer knows it; research does not). */
	familyName?: string;
	/** A milestone: `value` once, from this tech level on (instead of `value` per level). */
	atLevel?: number;
}

/** A tech's hold on a building's levels: from tech level `level` on, the building may reach `from` and above. */
export interface TechUnlock {
	building: string;
	at: { level: number; from: number }[];
}

/** A tech as both ends work it out: its tables, place in the tree and effects (those of `stats` / `percent` and describers'). */
export interface TechPlan {
	id: string;
	/** Name key (likewise `description`, `quote`, `branch`). */
	name: string;
	description?: string;
	maxLevel: number;
	levels: (PlanRow | null)[];
	costGrowth?: number;
	timeGrowth?: number;
	requires?: Record<string, number>;
	unlocks?: TechUnlock[];
	branch?: string;
	tier?: number;
	order?: number;
	quote?: string;
	effects: TechEffect[];
	/** The plugin that defined it: its effects' and tiers' labels are keys of that plugin. None for a runtime node. */
	owner?: string;
}

/** `data` of the static view `research.techs`: the shared tree's techs and what their quotes and lines need. */
export interface ResearchCatalog {
	/** Rules: growth of levels past a table, the global speed multiplier. */
	growth: { cost: number; time: number };
	speed: number;
	/** Content techs, then those the GM added for everyone (in the order they were added). */
	techs: TechPlan[];
	/** Building name keys, for unlock lines. */
	buildings: Record<string, string>;
	/** Resource icons, for prices. */
	icons: Record<string, string>;
	/** Stat names, for the effects of a runtime node (no plugin's labels). */
	stats: Record<string, UiText>;
}

/** Cost and time of `level` of a tech in a settlement: its table, growth past it, the modifiers' factors and the speed. */
export function techQuote(
	def: Pick<TechPlan, 'levels' | 'costGrowth' | 'timeGrowth'>,
	level: number,
	rules: Pick<ResearchCatalog, 'growth' | 'speed'>,
	here: { labSpeed: number; costFactor: number; timeFactor: number },
): PlanRow {
	const { row, beyond } = planRow(def.levels, level);
	return {
		cost: Object.fromEntries(
			Object.entries(row.cost).map(([r, n]) => [r, Math.ceil(n * (def.costGrowth ?? rules.growth.cost) ** beyond * here.costFactor)]),
		),
		seconds: Math.max(
			1,
			Math.ceil((row.seconds * (def.timeGrowth ?? rules.growth.time) ** beyond * here.timeFactor) / (rules.speed * here.labSpeed)),
		),
	};
}

/**
 * A label key of the plugin that defined the tech. A runtime node has none: its effects are named by the stat they
 * change, its tiers and branch by research.
 */
const labelOf = (tech: Pick<TechPlan, 'owner'> | undefined, key: string, otherwise: () => UiText): UiText =>
	tech?.owner ? keyText(`${tech.owner}.${key}`) : otherwise();
// An effect on something that is no stat (e.g. a resource's output) shows its id.
const effectLabel = (tech: TechPlan, target: string, catalog: Pick<ResearchCatalog, 'stats'>) =>
	labelOf(tech, `effect:${target}`, () => catalog.stats[target] ?? literal(target));
export const tierLabel = (tech: Pick<TechPlan, 'owner'> | undefined, tier: string | number) =>
	labelOf(tech, `research-tier:${tier}`, () => text(`research-tier:${tier}`));

/** "Attack +2.5% per level", "Archers only", "at Lv 3 (once)": the tree's lines (the same for every player). */
export function effectText(e: TechEffect, tech: TechPlan, catalog: Pick<ResearchCatalog, 'stats'>): UiText {
	const vars = {
		effect: effectLabel(tech, e.target, catalog),
		value: signed(e.value, e.percent),
		...(e.familyName ? { family: keyText(e.familyName) } : {}),
		...(e.atLevel ? { lv: e.atLevel } : {}),
	};
	// A milestone as on the player's own cards ("★ Lv 3: …"): the node's level is beside it.
	if (e.atLevel)
		return e.familyName ? text('★ Lv {lv}: {effect} {value} (only {family})', vars) : text('★ Lv {lv}: {effect} {value}', vars);
	return e.familyName ? text('{effect} {value} (only {family}) per level', vars) : text('{effect} {value} per level', vars);
}

/**
 * A player's own card of a tech at `level`, as building cards (user 2026-10-19: "太丑了……业界的最佳实践是什么样子？";
 * "举一反三……科技等级"; plan A): a per-level effect as "Attack +7.5% → +10%"; a milestone not reached as
 * "★ Lv 5: Attack +5%", one reached as what it gives.
 */
export function effectLine(
	e: TechEffect,
	tech: TechPlan,
	level: number,
	catalog: Pick<ResearchCatalog, 'stats'>,
): { text: UiText; tone: 'info' | 'muted' } {
	const vars = {
		effect: effectLabel(tech, e.target, catalog),
		value: signed(e.value, e.percent),
		now: signed(e.value * level, e.percent),
		next: signed(e.value * (level + 1), e.percent),
		...(e.familyName ? { family: keyText(e.familyName) } : {}),
		...(e.atLevel ? { lv: e.atLevel } : {}),
	};
	const only = !!e.familyName;
	if (e.atLevel && level >= e.atLevel)
		return { text: only ? text('{effect} {value} (only {family})', vars) : text('{effect} {value}', vars), tone: 'info' };
	if (e.atLevel)
		return {
			text: only ? text('★ Lv {lv}: {effect} {value} (only {family})', vars) : text('★ Lv {lv}: {effect} {value}', vars),
			tone: 'muted',
		};
	return { text: only ? text('{effect} {now} → {next} (only {family})', vars) : text('{effect} {now} → {next}', vars), tone: 'info' };
}

/** What a tech's building nodes say: the one reached ("unlocked from level 6"), then the next ("Lv 3: from level 10"). */
export const unlockLines = (x: { level: number; unlocks: TechUnlock[] }, catalog: Pick<ResearchCatalog, 'buildings'>): UiText[] =>
	x.unlocks.flatMap((u) => {
		const building = keyText(catalog.buildings[u.building] ?? u.building);
		const reached = u.at.filter((n) => x.level >= n.level).at(-1);
		const next = u.at.find((n) => x.level < n.level);
		return [
			...(reached ? [text('Unlocked: {building} Lv {from} and above', { building, from: reached.from })] : []),
			...(next ? [text('★ Lv {lv}: unlocks {building} Lv {from} and above', { lv: next.level, building, from: next.from })] : []),
		];
	});

/** A node of the tree as every player has it: name, motto, effects, prerequisites (in the branch as lines, else tags). */
function treeNode(d: TechPlan, all: Map<string, TechPlan>, catalog: Pick<ResearchCatalog, 'stats'>): TreeNode {
	const branch = (id: string) => all.get(id)?.branch ?? 'Other';
	return {
		id: d.id,
		title: keyText(d.name),
		...(d.quote ? { quote: keyText(d.quote) } : {}),
		// Per level first, the milestones ("★ Lv 3: …") after them.
		lines: [...d.effects.filter((e) => !e.atLevel), ...d.effects.filter((e) => e.atLevel)].map((e) => ({
			text: effectText(e, d, catalog),
		})),
		requires: Object.keys(d.requires ?? {})
			.filter((req) => branch(req) === branch(d.id))
			.map((req) => ({ id: req, met: false })),
		tags: Object.entries(d.requires ?? {})
			.filter(([req]) => branch(req) !== branch(d.id))
			.map(([req, level]) => ({
				id: req,
				text: text('{tech} {n}', { tech: keyText(all.get(req)?.name ?? req), n: level }),
				met: false,
			})),
	};
}

/** Branches of tiers of nodes, in the content's order. */
export function treeLayout(list: TechPlan[], all: Map<string, TechPlan>, catalog: Pick<ResearchCatalog, 'stats'>): TreeData['groups'] {
	const branches: string[] = [];
	for (const x of list) if (!branches.includes(x.branch ?? 'Other')) branches.push(x.branch ?? 'Other');
	return branches.map((b) => {
		const techs = list.filter((x) => (x.branch ?? 'Other') === b);
		const tiers = Math.max(1, ...techs.map((x) => x.tier ?? 1));
		return {
			id: b,
			label: keyText(b),
			columns: Array.from({ length: tiers }, (_, i) => ({
				label: tierLabel(techs[0], i + 1),
				nodes: techs
					.filter((x) => (x.tier ?? 1) === i + 1)
					.sort((p, q) => (p.order ?? 0) - (q.order ?? 0))
					.map((x) => treeNode(x, all, catalog)),
			})),
		};
	});
}
