// Heroes against the realms (1.3.3 balancing; re-tuned 2026-10-21): a typical hero (a recruiting building's candidate
// at its middle values, its mean talent every level, free points into might and leadership) by hero level, which tasks
// of each realm it clears with a margin of at least 1 ("worth a try"), and how long levelling takes on the best task it
// clears. The adventure formulas, talents and ranges come from the rules (starter-realms.heroStats, starter-heroes.*),
// so the same sim compares content before and after a change. Gear: a full set of the best kind the realms cleared so
// far drop, in white (and in blue: what rarer gear adds).
import { describe, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import { margin } from '../../src/shared/realms';
import { defaultKernel } from '../helpers';

const config = engineContext(defaultKernel, 'sim', 0).config;
const api = { config } as never;
const realms = defaultKernel.services.get('realms');
const HERO_STATS = config['starter-realms.heroStats'] as Record<string, Record<string, number>>;
const RANGES = config['starter-heroes.ranges'] as Record<string, Record<string, [number, number]>>;
const TALENTS = config['starter-heroes.talents'] as Record<string, Record<string, number>>;
const GROUP_SECONDS = (config['realms.rules'] as { groupSeconds: number }).groupSeconds;
const ATTRS = ['might', 'leadership', 'strategy', 'governance', 'learning', 'charm'];
// Candidates x this at building level L (starter-heroes.levelFactor: 0.2 at 1, 1 at 10, 1.5 at 20).
const factor = (l: number) => (l <= 10 ? 0.2 + ((l - 1) * 0.8) / 9 : 1 + ((Math.min(l, 20) - 10) * 0.5) / 10);
/** A venue's middle values, and its mean talent a level spread like the roll (by range middles; the music house 1-3 each). */
function venue(id: string) {
	const mid = Object.fromEntries(ATTRS.map((a) => [a, (RANGES[id][a][0] + RANGES[id][a][1]) / 2]));
	const table = Object.entries(TALENTS[id]);
	const total = table.reduce((s, [p, w]) => s + Number(p) * w, 0) / table.reduce((s, [, w]) => s + w, 0);
	const sum = ATTRS.reduce((s, a) => s + mid[a], 0);
	const even = id === 'music-house' && total >= 6;
	const spread = (a: string) => (even ? Math.min(3, 1 + ((total - 6) * mid[a]) / sum) : (total * mid[a]) / sum);
	return { mid, talent: Object.fromEntries(ATTRS.map((a) => [a, spread(a)])), total };
}

// Regular sets by the first realm that drops them (starter-equipment pieces.csv / sets.csv): scale, attrs factor.
const SETS = [
	{ from: 1, scale: 1, attrs: 1 },
	{ from: 2, scale: 1.8, attrs: 1.5 },
	{ from: 3, scale: 3.24, attrs: 2 },
	{ from: 5, scale: 5.83, attrs: 2.5 },
	{ from: 6, scale: 10.5, attrs: 3 },
	{ from: 8, scale: 18.9, attrs: 3.5 },
	{ from: 9, scale: 34.01, attrs: 4 },
];
// rarities.csv: mult on the base stats, six-attribute points a piece (x the set's attrs factor).
const RARITY = { white: { mult: 1, attrs: 0 }, blue: { mult: 1.3, attrs: 8 } };
type Rarity = keyof typeof RARITY;
/** A full set of the best kind that drops in the realms cleared so far (weapon, helm, armour, boots, trinket). */
const gear = (realmsCleared: number, rarity: Rarity) => {
	if (!realmsCleared) return { attack: 0, defense: 0, hp: 0, recovery: 0, attrs: 0 };
	const set = [...SETS].reverse().find((x) => x.from <= realmsCleared)!;
	const k = set.scale * RARITY[rarity].mult;
	return { attack: 30 * k, defense: 35 * k, hp: 300 * k, recovery: 3, attrs: 5 * RARITY[rarity].attrs * set.attrs };
};

function hero(v: string, buildingLevel: number, level: number, realmsCleared = 0, rarity: Rarity = 'white') {
	const { mid, talent } = venue(v);
	const g = gear(realmsCleared, rarity);
	const f = factor(buildingLevel);
	const a: Record<string, number> = {};
	// Gear's six-attribute points land at random: a sixth on each.
	for (const k of ATTRS) a[k] = Math.max(1, Math.round(mid[k] * f)) + talent[k] * (level - 1) + g.attrs / 6;
	const free = 6 * (level - 1);
	a.might += free / 2;
	a.leadership += free / 2;
	const stat = (s: string) => Object.entries(HERO_STATS[s]).reduce((sum, [k, x]) => sum + (k === 'base' ? x : (a[k] ?? 0) * x), 0);
	return {
		attack: stat('attack') + g.attack,
		defense: stat('defense') + g.defense,
		hp: stat('hp') + g.hp,
		recovery: stat('recovery') + g.recovery,
	};
}

describe('realms', () => {
	it('what a typical hero clears, and how fast it levels', () => {
		const list = [...realms.list()].sort((a, b) => a.order - b.order);
		/** Realms whose every task the hero clears, wearing what the ones before drop (until it stops improving). */
		const progress = (v: string, b: number, lv: number, rarity: Rarity = 'white') => {
			let done = 0;
			for (;;) {
				const h = hero(v, b, lv, done, rarity);
				const next = list.findIndex((r) => r.tasks(api).some((t) => margin(h, t.groups) < 1));
				const cleared = next < 0 ? list.length : next;
				if (cleared <= done) return { done, h };
				done = cleared;
			}
		};
		const lines = [`talent a level: ${['tavern', 'academy', 'music-house'].map((v) => `${v} ${venue(v).total.toFixed(2)}`).join(', ')}`];
		const cases: [string, Rarity, number[]][] = [
			['tavern', 'white', [1, 5, 10, 20]],
			['tavern', 'blue', [1, 10, 20]],
			['music-house', 'white', [1, 10, 20]],
		];
		for (const [v, rarity, levels] of cases)
			for (const b of levels)
				for (const lv of [1, 5, 10, 20, 30, 45, 60]) {
					const { h, done } = progress(v, b, lv, rarity);
					const cleared = list.map((r) => r.tasks(api).filter((t) => margin(h, t.groups) >= 1).length + '/' + r.tasks(api).length);
					const m = margin(h, list[0].tasks(api)[0].groups);
					lines.push(
						`${v} ${b} ${rarity}, hero ${lv}: ${cleared.join(' ')} (all of ${done}; 1.1 margin ${m.toFixed(2)}; atk ${Math.round(h.attack)} def ${Math.round(h.defense)} hp ${Math.round(h.hp)})`,
					);
				}
		// Levelling: at each level, the task with the most experience per hour among those cleared (margin >= 1).
		for (const b of [1, 10]) {
			let hours = 0;
			const marks: string[] = [];
			for (let lv = 1; lv < 60; lv++) {
				const { h } = progress('tavern', b, lv);
				let best = 0;
				let where = '';
				for (const r of list)
					for (const [i, t] of r.tasks(api).entries())
						if (margin(h, t.groups) >= 1) {
							const perHour = (t.exp.reduce((x, y) => x + y, 0) / (t.groups.length * GROUP_SECONDS)) * 3600;
							if (perHour > best) [best, where] = [perHour, `${r.order}.${i + 1}`];
						}
				const need = 100 * lv ** 1.5;
				hours += best ? need / best : Infinity;
				if ([2, 5, 10, 20, 30, 45, 60].includes(lv + 1)) marks.push(`lv ${lv + 1} at ${hours.toFixed(1)} h (on ${where})`);
			}
			lines.push(`tavern ${b} levelling (adventuring nonstop): ${marks.join(', ')}`);
		}
		throw new Error(lines.join('\n'));
	});
});
