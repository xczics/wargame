// Heroes against the realms (1.3.3 balancing): a typical hero (a recruiting building's candidate at its middle values,
// free points into might and leadership, no equipment) by hero level, which tasks of each realm it clears with a
// margin of at least 1 ("worth a try"), and how long levelling takes on the best task it clears.
import { describe, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import { margin } from '../../src/shared/realms';
import { defaultKernel } from '../helpers';

// Realm difficulty under test (starter-realms.difficulty; realms 1-2 are x0.25 in the content).
const DIFFICULTY: Record<string, number> = {};
const api = { config: engineContext(defaultKernel, 'sim', 0, { 'starter-realms.difficulty': DIFFICULTY }).config } as never;
const realms = defaultKernel.services.get('realms');
// The tavern's ranges (starter-heroes ranges.csv), middle values.
const MID = { might: 77.5, leadership: 72.5, strategy: 40, governance: 40, learning: 32.5, charm: 50 };
// Candidates x this at building level L (starter-heroes.levelFactor: 0.2 at 1, 1 at 10, 1.5 at 20).
const factor = (l: number) => (l <= 10 ? 0.2 + ((l - 1) * 0.8) / 9 : 1 + ((Math.min(l, 20) - 10) * 0.5) / 10);

// White sets by the first realm that drops them (starter-equipment pieces.csv / sets.csv): scale.
const SETS = [
	{ from: 1, scale: 1 },
	{ from: 2, scale: 1.8 },
	{ from: 3, scale: 3.24 },
	{ from: 5, scale: 5.83 },
	{ from: 6, scale: 10.5 },
	{ from: 8, scale: 18.9 },
	{ from: 9, scale: 34.01 },
];
/** A full white set of the best kind that drops in the realms cleared so far (weapon, helm, armour, boots, trinket). */
const gear = (realmsCleared: number) => {
	const set = [...SETS].reverse().find((x) => x.from <= Math.max(1, realmsCleared));
	const k = realmsCleared ? set!.scale : 0;
	return { attack: 30 * k, defense: 35 * k, hp: 300 * k, recovery: realmsCleared ? 3 : 0 };
};

function hero(buildingLevel: number, level: number, realmsCleared = 0) {
	const f = factor(buildingLevel);
	const a = Object.fromEntries(Object.entries(MID).map(([k, v]) => [k, Math.max(1, Math.round(v * f))])) as typeof MID;
	const free = 6 * (level - 1);
	a.might += free / 2;
	a.leadership += free / 2;
	// starter-realms hero-stats.csv
	const g = gear(realmsCleared);
	return {
		attack: 10 + 2 * a.might + 0.5 * a.strategy + g.attack,
		defense: 5 + 0.3 * a.might + a.leadership + g.defense,
		hp: 100 + 2 * a.might + 6 * a.leadership + g.hp,
		recovery: 5 + 0.05 * a.learning + 0.05 * a.charm + g.recovery,
	};
}

describe('realms', () => {
	it('what a typical hero clears, and how fast it levels', () => {
		const list = [...realms.list()].sort((a, b) => a.order - b.order);
		/** Realms whose every task the hero clears, wearing what the ones before drop (until it stops improving). */
		const progress = (b: number, lv: number) => {
			let done = 0;
			for (;;) {
				const h = hero(b, lv, done);
				const next = list.findIndex((r) => r.tasks(api).some((t) => margin(h, t.groups) < 1));
				const cleared = next < 0 ? list.length : next;
				if (cleared <= done) return { done, h };
				done = cleared;
			}
		};
		const lines: string[] = [];
		for (const b of [1, 5, 10, 20])
			for (const lv of [1, 5, 10, 20, 30, 45, 60, 90]) {
				const { h } = progress(b, lv);
				const cleared = list.map((r) => r.tasks(api).filter((t) => margin(h, t.groups) >= 1).length + '/' + r.tasks(api).length);
				lines.push(`tavern ${b}, hero ${lv}: ${cleared.join(' ')}`);
			}
		// Levelling: at each level, the task with the most experience per hour among those cleared (margin >= 1).
		const groupSeconds = 120;
		for (const b of [1, 10]) {
			let hours = 0;
			const marks: string[] = [];
			for (let lv = 1; lv < 90; lv++) {
				const { h } = progress(b, lv);
				let best = 0;
				let where = '';
				for (const r of list)
					for (const [i, t] of r.tasks(api).entries())
						if (margin(h, t.groups) >= 1) {
							const perHour = (t.exp.reduce((x, y) => x + y, 0) / (t.groups.length * groupSeconds)) * 3600;
							if (perHour > best) [best, where] = [perHour, `${r.order}.${i + 1}`];
						}
				const need = 100 * lv ** 1.5;
				hours += best ? need / best : Infinity;
				if ([2, 5, 10, 20, 30, 45, 60, 89].includes(lv + 1)) marks.push(`lv ${lv + 1} at ${hours.toFixed(1)} h (on ${where})`);
			}
			lines.push(`tavern ${b} levelling (adventuring nonstop): ${marks.join(', ')}`);
		}
		throw new Error(lines.join('\n'));
	});
});
