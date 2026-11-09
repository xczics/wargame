/**
 * The heroes' effects (starter-heroes): what a hero gives on a duty, and how it reads. One piece of code for the server
 * (battles, bonuses, the posts) and the browser (the hero cards, from the static `starter-heroes.effects`).
 */
import type { HeroRoleEffects } from './api';
import { precise, signed } from './format';

/** A row of effects.csv: on `duty`, each point of `attribute` gives `effect` (its own % per point, else the rule's). */
export interface HeroEffectRow {
	duty: string;
	effect: string;
	attribute: string;
	perPoint?: number;
}
/** The rule `starter-heroes.effect`'s numbers the % come from. */
export interface HeroEffectRules {
	perPoint: number;
	battlePerPoint: number;
	battleLevelPower: number;
	flatLevelPower: number;
}
/** A row of battle-flat.csv (rule `starter-heroes.battleFlat`): on `duty`, each point of `attribute` adds `perPoint` x level^flatLevelPower to `stat` in every lane. */
export interface HeroFlatRow {
	duty: string;
	attribute: string;
	stat: string;
	perPoint: number;
}
/** The static `starter-heroes.effects` (baked per rules): the rows, the flat rows and the rule. */
export interface HeroEffectsStatic {
	rows: HeroEffectRow[];
	/** Absent in what was baked before 2026-11-08. */
	flat?: HeroFlatRow[];
	rules: HeroEffectRules;
}

// Leading or defending, attack / defence / hp grow with the hero's level.
const BATTLE_GROWING = new Set(['attack', 'defense', 'hp']);
const isBattle = (duty: string) => duty === 'command' || duty === 'defend';

/** One hero's % from a row: in battle (command / defend) by the battle formula, elsewhere per point. */
export function rowPercent(row: HeroEffectRow, rules: HeroEffectRules, hero: { attrs: Record<string, number>; level: number }): number {
	const pts = hero.attrs[row.attribute] ?? 0;
	if (!isBattle(row.duty)) return pts * (row.perPoint ?? rules.perPoint);
	return BATTLE_GROWING.has(row.effect) ? pts * rules.battlePerPoint * hero.level ** rules.battleLevelPower : pts * rules.perPoint;
}

/** What a group of heroes gives acting as `duty`, by effect, in the rows' order. */
export function dutyEffects(
	rows: readonly HeroEffectRow[],
	rules: HeroEffectRules,
	duty: string,
	group: readonly { attrs: Record<string, number>; level: number }[],
): { effect: string; percent: number }[] {
	const out = new Map<string, number>();
	for (const row of rows.filter((x) => x.duty === duty))
		out.set(row.effect, (out.get(row.effect) ?? 0) + group.reduce((sum, h) => sum + rowPercent(row, rules, h), 0));
	return [...out].map(([effect, percent]) => ({ effect, percent }));
}

/** The flat numbers a group of heroes adds to every lane acting as `duty` (command / defend), by stat, unrounded. */
export function flatOf(
	rows: readonly HeroFlatRow[],
	rules: HeroEffectRules,
	duty: string,
	group: readonly { attrs: Record<string, number>; level: number }[],
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of rows.filter((x) => x.duty === duty))
		for (const h of group) out[f.stat] = (out[f.stat] ?? 0) + (h.attrs[f.attribute] ?? 0) * f.perPoint * h.level ** rules.flatLevelPower;
	return out;
}

/** What one hero adds to every lane in each battle role (its card), rounded as the battle rounds it; none: no entry. */
export function roleFlats(
	rows: readonly HeroFlatRow[],
	rules: HeroEffectRules,
	hero: { attrs: Record<string, number>; level: number },
): Record<string, Record<string, number>> {
	const out: Record<string, Record<string, number>> = {};
	for (const role of new Set(rows.map((r) => r.duty))) {
		const list = Object.entries(flatOf(rows, rules, role, [hero]))
			.map(([stat, v]) => [stat, Math.round(v)] as const)
			.filter(([, v]) => v);
		if (list.length) out[role] = Object.fromEntries(list);
	}
	return out;
}

/** What one hero would give in each role (its card): attributes with every bonus. */
export function roleEffects(
	rows: readonly HeroEffectRow[],
	rules: HeroEffectRules,
	hero: { attrs: Record<string, number>; level: number },
): HeroRoleEffects {
	const out: HeroRoleEffects = {};
	for (const role of new Set(rows.map((r) => r.duty))) {
		const list = dutyEffects(rows, rules, role, [hero]);
		if (list.length) out[role] = Object.fromEntries(list.map((e) => [e.effect, precise(e.percent)]));
	}
	return out;
}

// Effects that lower something (cost, losses): a reduction reads as a minus. Time cuts read as the speed they give
// (time ÷ (1 + x%) = speed + x%; user 2026-11-04: "建造速度 +X%"…"统一修改之").
const REDUCTIONS = new Set(['upkeep', 'researchCost', 'casualty']);

/** An effect's value as shown: "+12%", or "−5%" for a reduction (its points; what they take off is by `reduction`). */
export const effectValue = (e: { effect: string; percent: number }) => signed(REDUCTIONS.has(e.effect) ? -e.percent : e.percent, true, 1);
