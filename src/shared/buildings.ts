/**
 * A building at any level, from its tables and the rules (static view `buildings.catalog`): its cost, time and
 * effects, and its card on the City page. The server uses it for quotes and effects; the client builds the cards
 * with it (templates "<building>@<level>", any level: past the regular cap too), so the player's view only says
 * which building and level each slot has. Pure functions.
 */
import { amount } from './format';
import { keyText, literal, uiTexts } from './i18n';
import { type GrowthStage, planRow, type PlanRow, stagedGrowth } from './levels';
import type { BuildingEffects } from './api';
import type { UiActionPart, UiCard, UiChoice, UiLine, UiNeed, UiText } from './ui';

const text = uiTexts('buildings');

/** What a building's level math needs (its rules and content). */
export interface BuildingPlan {
	/** Name key. */
	name: string;
	icon?: string;
	/** Regular cap. */
	cap: number;
	levels: readonly (PlanRow | null)[];
	costGrowth: number;
	/** From this level on each level costs `lateCostGrowth` times the one before instead (e.g. core buildings past 20). */
	lateCostFrom?: number;
	lateCostGrowth?: number;
	timeGrowth: number;
	produces?: Record<string, number>;
	stats?: Record<string, number>;
	statsGrowth?: GrowthStage[];
	/** Output per level grows faster from these levels on (see `stagedGrowth`); linear without. */
	producesGrowth?: GrowthStage[];
	/** Output before the first growth stage is per level x level^this (default 1: linear). */
	producesPower?: number;
	statSteps?: Record<string, number[]>;
	/** What starting a level needs from other systems (e.g. a tech): from level `from` on, `need` (the latest band per counter). */
	gates?: { from: number; need: UiNeed }[];
}

/** For effect texts: resource icons, and the stats buildings give (name, percent or not, hidden). */
export interface EffectNames {
	icons: Record<string, string>;
	stats: Record<string, { description: UiText; percent?: boolean; hidden?: boolean }>;
}

export interface BuildingCatalog extends EffectNames {
	/** Rules: build speed multiplier, production multiplier, own resource free up to this level. */
	speed: number;
	productionMultiplier: number;
	ownResourceFreeUntil: number;
	buildings: Record<string, BuildingPlan>;
}

/** Counters the city page's cards go by: the settlement's construction-time factor, free places in its queue. */
export const TIME_COUNTER = 'buildings.time';
export const QUEUE_COUNTER = 'buildings.queueFree';

/** Cost and time of reaching `level` (before the settlement's own time factor). */
export function levelCost(
	plan: Pick<BuildingPlan, 'levels' | 'costGrowth' | 'timeGrowth' | 'produces' | 'lateCostFrom' | 'lateCostGrowth'>,
	level: number,
	rules: { speed: number; ownResourceFreeUntil: number },
): PlanRow {
	const { row, beyond } = planRow(plan.levels, level);
	const own = level <= rules.ownResourceFreeUntil ? (plan.produces ?? {}) : {};
	// The levels past the table grow by costGrowth, those past lateCostFrom by lateCostGrowth.
	const late = plan.lateCostFrom && plan.lateCostGrowth ? Math.min(beyond, Math.max(0, level - plan.lateCostFrom + 1)) : 0;
	const growth = plan.costGrowth ** (beyond - late) * (plan.lateCostGrowth ?? 1) ** late;
	return {
		cost: Object.fromEntries(
			Object.entries(row.cost)
				.filter(([res]) => !own[res])
				.map(([res, c]) => [res, Math.ceil(c * growth)]),
		),
		seconds: Math.max(1, Math.ceil((row.seconds * plan.timeGrowth ** beyond) / rules.speed)),
	};
}

/** A building's stat at `level`: `perLevel` x level, faster from its growth stages, or one amount at each step reached. */
export function statAt(plan: Pick<BuildingPlan, 'statSteps' | 'statsGrowth'>, perLevel: number, level: number, stat: string) {
	const steps = plan.statSteps?.[stat];
	return steps ? perLevel * steps.filter((l) => l <= level).length : stagedGrowth(perLevel, level, plan.statsGrowth);
}

/** What a building gives at `level` (production with the production multiplier). */
export function levelEffects(
	plan: Pick<BuildingPlan, 'produces' | 'stats' | 'statSteps' | 'statsGrowth' | 'producesGrowth' | 'producesPower'>,
	level: number,
	productionMultiplier: number,
): BuildingEffects {
	return {
		produces: Object.fromEntries(
			Object.entries(plan.produces ?? {}).map(([r, n]) => [
				r,
				stagedGrowth(n, level, plan.producesGrowth, plan.producesPower) * productionMultiplier,
			]),
		),
		stats: Object.fromEntries(Object.entries(plan.stats ?? {}).map(([s, n]) => [s, statAt(plan, n, level, s)])),
	};
}

/** Effects as texts: "🌾 +2/s", "Equipment storage +20", "Construction speed +3%", then other plugins' lines. */
export function effectTexts(e: BuildingEffects, names: EffectNames): UiText[] {
	return [
		...Object.entries(e.produces).map(([r, n]) => literal(`${names.icons[r] ?? r} +${amount(n, 1)}/s`)),
		...Object.entries(e.stats)
			// Nothing yet (a stat given only at some levels, none reached): not "+0".
			.filter(([s, n]) => n !== 0 && !names.stats[s]?.hidden)
			.map(([s, n]) => {
				const stat = names.stats[s];
				const name = stat?.description ?? literal(s);
				return stat?.percent ? text('{1} +{0}%', { 0: amount(n, 2), 1: name }) : text('{1} +{0}', { 0: amount(n, 2), 1: name });
			}),
		...(e.lines ?? []),
	];
}

/** The price as button parts: each resource (the client counts it against the settlement's), then the time. */
function priceParts(c: BuildingCatalog, row: PlanRow): UiActionPart[] {
	return [
		...Object.entries(row.cost)
			.filter(([, n]) => n > 0)
			.map(([r, n]) => ({ need: { counter: `resource:${r}`, amount: n, icon: c.icons[r] ?? r } })),
		{ seconds: row.seconds, factor: TIME_COUNTER },
	];
}

/** What starting `level` needs: a place in the queue, and the latest band of each gate reached. */
function needs(plan: BuildingPlan, level: number): UiNeed[] {
	const latest = new Map<string, UiNeed>();
	for (const g of [...(plan.gates ?? [])].sort((a, b) => a.from - b.from)) if (level >= g.from) latest.set(g.need.counter, g.need);
	return [{ counter: QUEUE_COUNTER, amount: 1, short: text('Construction queue full') }, ...latest.values()];
}

/**
 * What a level gives and what the next adds, as players read upgrades in such games (user 2026-10-19: "太丑了，再优化一下
 * 这种特定等级的额外bonus的显示方式。业界的最佳实践是什么样子？"): one line per effect, "Construction speed +10% → +15%" when
 * the next level changes it; a stat given only at some levels as its total so far, and the next of those levels as
 * "★ Lv 3: Outer city limit +1", the whole schedule on hover. Nothing at 0.
 */
function upgradeLines(c: BuildingCatalog, plan: BuildingPlan, level: number): UiLine[] {
	const now = levelEffects(plan, level, c.productionMultiplier);
	const next = levelEffects(plan, level + 1, c.productionMultiplier);
	const lines: UiLine[] = [];
	// The next steps last, after what every effect is now.
	const stars: UiLine[] = [];
	const fmt = (n: number, percent?: boolean) => `+${amount(n, 2)}${percent ? '%' : ''}`;
	const change = (name: UiText, a: number, b: number, percent?: boolean, unit = '') => {
		if (!a && !b) return;
		lines.push({
			text:
				a === b || level <= 0
					? text('{0} {1}', { 0: name, 1: `${fmt(level <= 0 ? b : a, percent)}${unit}` })
					: text('{0} {1} → {2}', { 0: name, 1: `${fmt(a, percent)}${unit}`, 2: `${fmt(b, percent)}${unit}` }),
			tone: 'info',
		});
	};
	for (const r of new Set([...Object.keys(now.produces), ...Object.keys(next.produces)]))
		change(literal(c.icons[r] ?? r), now.produces[r] ?? 0, next.produces[r] ?? 0, false, '/s');
	for (const s of new Set([...Object.keys(now.stats), ...Object.keys(next.stats)])) {
		const stat = c.stats[s];
		if (stat?.hidden) continue;
		const name = stat?.description ?? literal(s);
		const steps = plan.statSteps?.[s];
		if (!steps) {
			change(name, now.stats[s] ?? 0, next.stats[s] ?? 0, stat?.percent);
			continue;
		}
		// Stepped: the total so far, then the next step.
		const have = now.stats[s] ?? 0;
		if (have && level > 0) lines.push({ text: text('{0} {1}', { 0: name, 1: fmt(have, stat?.percent) }), tone: 'info' });
		const at = steps.find((l) => l > Math.max(0, level));
		const per = plan.stats?.[s] ?? 0;
		if (at !== undefined && per)
			stars.push({
				text: text('★ Lv {0}: {1} {2}', { 0: at, 1: name, 2: fmt(per, stat?.percent) }),
				tone: 'muted',
				hint: [
					text('{0}: {1} at Lv {2} (at most {3})', {
						0: name,
						1: fmt(per, stat?.percent),
						2: steps.join(' / '),
						3: fmt(per * steps.length, stat?.percent),
					}),
				],
			});
	}
	return [...lines, ...stars];
}

/** Building it in an empty slot (a choice of the slot's list). */
export function buildChoice(c: BuildingCatalog, id: string): UiChoice {
	const plan = c.buildings[id];
	const name = keyText(plan.name);
	return {
		id,
		lines: upgradeLines(c, plan, 0),
		action: {
			command: 'buildings.construct',
			payload: { building: id },
			label: text('{0} {1} ·', { 0: plan.icon ?? '🏗️', 1: name }),
			pending: text('Building {0}…', { 0: name }),
			parts: priceParts(c, levelCost(plan, 1, c)),
			short: text('Not enough resources'),
			needs: needs(plan, 1),
		},
	};
}

/**
 * The card of a building at `level` (template "<id>@<level>"): what it does now and at the next level, the upgrade
 * with its price, and opening it. The title shows the regular cap; a slot past it, or at its own cap, says so itself.
 */
export function buildingCard(c: BuildingCatalog, id: string, level: number): Partial<Omit<UiCard, 'id'>> | undefined {
	const plan = c.buildings[id];
	if (!plan || !Number.isInteger(level) || level < 1) return undefined;
	const name = keyText(plan.name);
	return {
		where: ['page:city', 'building#{id}'],
		icon: plan.icon ?? '🏗️',
		title: text('{0} · Lv {1}/{2}', { 0: name, 1: level, 2: plan.cap }),
		lines: upgradeLines(c, plan, level),
		actions: [
			{
				command: 'buildings.construct',
				payload: { building: id },
				label: text('Upgrade ·'),
				pending: text('Upgrading {0}…', { 0: name }),
				parts: priceParts(c, levelCost(plan, level + 1, c)),
				short: text('Not enough resources'),
				needs: needs(plan, level + 1),
			},
			{ entry: { kind: 'building', id: '', type: id, label: name }, label: text('Open') },
		],
	};
}

/** Templates by key for the generic cards (`defineTemplates('buildings', …)`): "<building>@<level>". */
export function buildingTemplate(data: unknown, key: string): Partial<Omit<UiCard, 'id'>> | undefined {
	const at = key.lastIndexOf('@');
	return at > 0 ? buildingCard(data as BuildingCatalog, key.slice(0, at), Number(key.slice(at + 1))) : undefined;
}
