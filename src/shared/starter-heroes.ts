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
}
/** The static `starter-heroes.effects` (baked per rules): the rows and the rule. */
export interface HeroEffectsStatic {
	rows: HeroEffectRow[];
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

// Effects that lower something (time, cost, losses): a reduction reads as a minus.
const REDUCTIONS = new Set(['construction', 'training', 'upkeep', 'research', 'researchCost', 'casualty']);

/** An effect's value as shown: "+12%", or "−5%" for a reduction. */
export const effectValue = (e: { effect: string; percent: number }) => signed(REDUCTIONS.has(e.effect) ? -e.percent : e.percent, true, 1);
