import type { HeroAttributePart } from './api';
import type { ClientViewGet } from './client-views';
import { seededRandom } from './random';

/**
 * A hero's name as name-part keys ("s:Zhao m:Zilong"), which the client spells for the locale (surname first, no
 * space in Chinese): the one way to put a name in a text, on the server (`heroes.nameKey`) and in the browser alike.
 */
export const nameKey = (h: { surname: string; given: string }) => (h.given ? `${h.surname} ${h.given}` : h.surname);

/**
 * A hero's attributes in the browser: its own plus what the client parts at "heroes.attributes" add (e.g. its gear),
 * as the server's `heroes.attributesOf` sums them.
 */
export function heroAttributes(hero: { id: string; attrs: Record<string, number> }, get: ClientViewGet): Record<string, number> {
	const out = { ...hero.attrs };
	for (const add of get.parts<HeroAttributePart>('heroes.attributes').values())
		for (const [a, n] of Object.entries(add(hero, get))) out[a] = (out[a] ?? 0) + n;
	return out;
}

/** The heroes' growth rule (GM rule `heroes.growth`; static view `heroes.growth` for the browser). */
export interface HeroGrowth {
	expBase: number;
	expPower: number;
	/** Highest level, 0 = none. */
	maxLevel: number;
	freePerLevel: number;
	steepFrom: number;
	steepGrowth: number;
}

/**
 * Experience from `level` to the next (null: the highest level), the same on both ends (user 2026-11-24: "英雄经验要求难道
 * 不是通用规则吗？不早该缓存到那静态资源里了吗"): expBase x L^expPower, past steepFrom x steepGrowth more for every level.
 */
export function expToNextOf(g: HeroGrowth, level: number): number | null {
	if (g.maxLevel > 0 && level >= g.maxLevel) return null;
	// Past steepFrom levels come dearer and dearer (user 2026-10-06: no cap, but past 90 better-born heroes and gear
	// should pay more than more levels).
	const steep = g.steepFrom > 0 && level >= g.steepFrom ? (g.steepGrowth || 1) ** (level - g.steepFrom + 1) : 1;
	return Math.round(g.expBase * level ** g.expPower * steep);
}

/** What experience changes on a hero (its level, experience, free points, and attributes when it levels up). */
export interface HeroGrowing {
	id: string;
	level: number;
	exp: number;
	talent: number;
	talents: Record<string, number> | null;
	freePoints: number;
	attrs: Record<string, number>;
	alloc: Record<string, number>;
}

/**
 * A hero after `exp` more experience, the same on both ends (`heroes.grantExp`; the browser for an item's experience):
 * each level reached gives `freePerLevel` free points and its talent points (by attribute when it has them, else spread
 * by a roll seeded by the hero and the level, weighted by its born attributes). At the highest level experience stays
 * at 0. Nothing gained at the highest level or for none.
 */
export function withExp<H extends HeroGrowing>(hero: H, exp: number, g: HeroGrowth): H {
	if (exp <= 0 || expToNextOf(g, hero.level) === null) return hero;
	const h = { ...hero, attrs: { ...hero.attrs }, exp: hero.exp + Math.floor(exp) };
	for (let need = expToNextOf(g, h.level); need !== null && h.exp >= need; need = expToNextOf(g, h.level)) {
		h.exp -= need;
		h.level++;
		h.freePoints += g.freePerLevel;
		if (h.talents) {
			for (const [a, n] of Object.entries(h.talents)) h.attrs[a] = (h.attrs[a] ?? 0) + n;
			continue;
		}
		const ids = Object.keys(h.attrs);
		const weights = ids.map((a) => Math.max(1, (h.attrs[a] ?? 0) - (h.alloc[a] ?? 0)));
		const total = weights.reduce((x, y) => x + y, 0);
		const random = seededRandom(`talent:${h.id}:${h.level}`);
		for (let i = 0; i < h.talent; i++) {
			let pick = random() * total;
			let k = 0;
			while (k < ids.length - 1 && pick >= weights[k]) pick -= weights[k++];
			h.attrs[ids[k]] = (h.attrs[ids[k]] ?? 0) + 1;
		}
	}
	if (expToNextOf(g, h.level) === null) h.exp = 0;
	return h;
}

/**
 * A hero reborn (the rebirth's `heroes.reincarnate`), the same on both ends: back to level 1 with no experience, its
 * talent gains of the levels it had taken off its attributes, `talents` added to its talents, `freePoints` more, its
 * spent points forgotten (they stay in its attributes). Unchanged without talents by attribute.
 */
export function reincarnated<H extends Pick<HeroGrowing, 'level' | 'exp' | 'talent' | 'talents' | 'freePoints' | 'attrs' | 'alloc'>>(
	hero: H,
	add: { talents: Record<string, number>; freePoints: number },
): H {
	if (!hero.talents) return hero;
	const attrs = { ...hero.attrs };
	for (const [a, n] of Object.entries(hero.talents)) attrs[a] = (attrs[a] ?? 0) - n * (hero.level - 1);
	const talents = { ...hero.talents };
	for (const [a, n] of Object.entries(add.talents)) talents[a] = (talents[a] ?? 0) + n;
	return {
		...hero,
		attrs,
		talents,
		talent: Object.values(talents).reduce((x, y) => x + y, 0),
		alloc: {},
		level: 1,
		exp: 0,
		freePoints: hero.freePoints + add.freePoints,
	};
}

/**
 * Whether a hero is free to change what it does (its duty one the player may change at will: idle, a post; not away
 * leading an army, adventuring, injured...), by the duties of meta `heroes`. The hero card's forms (duty, home, gear)
 * and the assistant, which does only what the player could (user 2026-11-24: "小助手只是'秘书'").
 */
export const heroFree = (duty: string, duties: readonly { id: string; manual?: boolean }[] | undefined) =>
	!!duties?.find((d) => d.id === duty)?.manual;

/** Whether spending `points` fits the hero's free points, as the card's form allows it (whole, none negative, some). */
export function pointsFit(hero: { freePoints: number }, points: Record<string, number>): boolean {
	const values = Object.values(points);
	const sum = values.reduce((a, b) => a + b, 0);
	return values.every((n) => Number.isInteger(n) && n >= 0) && sum > 0 && sum <= hero.freePoints;
}
