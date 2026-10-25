/**
 * A building at any level, from its tables and the rules (static view `buildings.catalog`): its cost, time and
 * effects, and its card on the City page. The server uses it for quotes and effects; the client builds the cards
 * with it (templates "<building>@<level>", any level: past the regular cap too), so the player's view only says
 * which building and level each slot has. Pure functions.
 */
import { costNeeds, readable } from './format';
import { keyText, literal, uiTexts } from './i18n';
import { type GrowthStage, planRow, type PlanRow, stagedGrowth } from './levels';
import type { BuildingEffects, BuildingsState } from './api';
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
	/** One per settlement or per district (its empty slots then offer it no more). */
	unique?: 'settlement' | 'district';
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

/** Effects as texts: "🌾 +2/s", "Equipment storage +20", "Construction speed +3%", then other plugins' lines (worded). */
export function effectTexts(e: BuildingEffects & { lines?: UiText[] }, names: EffectNames): UiText[] {
	return [
		...Object.entries(e.produces).map(([r, n]) => literal(`${names.icons[r] ?? r} +${readable(n)}/s`)),
		...Object.entries(e.stats)
			// Nothing yet (a stat given only at some levels, none reached): not "+0".
			.filter(([s, n]) => n !== 0 && !names.stats[s]?.hidden)
			.map(([s, n]) => {
				const stat = names.stats[s];
				const name = stat?.description ?? literal(s);
				return stat?.percent ? text('{1} +{0}%', { 0: readable(n), 1: name }) : text('{1} +{0}', { 0: readable(n), 1: name });
			}),
		...(e.lines ?? []),
	];
}

/** The price as button parts: each resource (the client counts it against the settlement's), then the time. */
function priceParts(c: BuildingCatalog, row: PlanRow): UiActionPart[] {
	return [...costNeeds(row.cost, c.icons), { seconds: row.seconds, factor: TIME_COUNTER }];
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
	const fmt = (n: number, percent?: boolean) => `+${readable(n)}${percent ? '%' : ''}`;
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

/**
 * Other plugins' lines now and at the next level as one (plan A, user 2026-10-19, as the static cards): the same
 * sentence with what changes as "2,500 → 5,000"; a line only the next level has as "★ Lv 3: …"; a starred line (a
 * plugin's own next step) only as it is now.
 */
export function ownUpgradeLines(now: UiText[], next: UiText[], nextLevel: number): UiLine[] {
	const out: UiLine[] = [];
	const plain = (v: unknown) => typeof v === 'string' || typeof v === 'number';
	for (let i = 0; i < Math.max(now.length, next.length); i++) {
		const a = now[i];
		const b = next[i];
		if (a?.text.includes('★')) out.push({ text: a, tone: 'muted' });
		else if (a && b && a.text === b.text) {
			const vars: Record<string, unknown> = {};
			let merged = true;
			for (const k of new Set([...Object.keys(a.vars ?? {}), ...Object.keys(b.vars ?? {})])) {
				const va = a.vars?.[k];
				const vb = b.vars?.[k];
				if (JSON.stringify(va) === JSON.stringify(vb)) vars[k] = va;
				else if (plain(va) && plain(vb)) vars[k] = `${va} → ${vb}`;
				else merged = false;
			}
			out.push({ text: merged ? ({ ...a, vars } as UiText) : a, tone: 'info' });
			if (!merged) out.push({ text: text('★ Lv {0}: {1}', { 0: nextLevel, 1: b }), tone: 'muted' });
		} else {
			if (a) out.push({ text: a, tone: 'info' });
			if (b && !b.text.includes('★')) out.push({ text: text('★ Lv {0}: {1}', { 0: nextLevel, 1: b }), tone: 'muted' });
		}
	}
	return out;
}

/** A district's name: the inner city, outer city n, the fortress (the buildings plugin's words). */
export const districtLabel = (type: string, idx: number): UiText =>
	type === 'inner' ? text('Inner city') : type === 'outer' ? text('Outer city {0}', { 0: idx }) : text('Fortress');

/**
 * A settlement's slots from its buildings (`buildings.state`), district by district: what stands in each and what is
 * being built there; and whether a unique building is taken (there or being built: in the district for those unique
 * per district, else anywhere). The City page's cards and the assistant's slot list go by it.
 */
export function slotsOf(
	state: Pick<BuildingsState, 'settlement' | 'slots' | 'construction'>,
	plans: Record<string, Pick<BuildingPlan, 'unique'>>,
) {
	const placed = new Map(state.slots.map((p) => [`${p.district}/${p.slot}`, p]));
	const building = new Map(state.construction.map((c) => [`${c.district}/${c.slot}`, c]));
	const has = (b: string, district?: string) =>
		state.slots.some((p) => p.building === b && (!district || p.district === district)) ||
		state.construction.some((c) => c.building === b && (!district || c.district === district));
	return {
		slots: state.settlement.districts.flatMap((district) =>
			Array.from({ length: district.slots }, (_, slot) => ({
				district,
				slot,
				placed: placed.get(`${district.id}/${slot}`) ?? null,
				building: building.get(`${district.id}/${slot}`) ?? null,
			})),
		),
		taken: (id: string, district: string) => (plans[id]?.unique === 'district' ? has(id, district) : !!plans[id]?.unique && has(id)),
	};
}
