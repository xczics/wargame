// What NPC camps cost and bring, at each level (1.3.3 balancing): the smallest army of tier-1 units (a third each of
// infantry, archers and cavalry) that wins at least three lanes, five lanes, and what it loses and takes home.
import { describe, it } from 'vitest';
import { resolveConfig } from '../../src/kernel';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo, BattleReport } from '../../src/shared/api';
import { defaultKernel, player, T0 } from '../helpers';

const real = resolveConfig(defaultKernel, {}).values;
const sum = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);

async function attack(kind: string, level: number, n: number) {
	const p = player({
		'armies.speed': 1e6,
		'armies.minSeconds': 0,
		'npc-camps.starterCamps': [],
		'starter-army.training': real['starter-army.training'],
		'buildings.productionMultiplier': real['buildings.productionMultiplier'],
	});
	const c = await p.start();
	const each = Math.ceil(n / 3);
	const units = { 'infantry-1': each, 'archer-1': each, 'cavalry-1': each };
	for (const [unit, count] of Object.entries(units)) await p.run(T0, 'troops.grant', { settlement: c.id, unit, count }, true);
	const at = { x: wrap(c.x + 3), y: c.y };
	await p.run(T0, 'npc-camps.spawnAt', { kind, ...at, level }, true);
	await p.run(T0, 'armies.send', { from: c.id, ...at, units });
	const [army] = (await p.views(T0 + 1_000, ['armies.list']))['armies.list'] as ArmyInfo[];
	const r = army.report as BattleReport;
	const won = r.battle?.lanes.filter((l) => l.winner === 'attacker').length ?? 0;
	return { won, lost: sum(r.losses.attacker), loot: sum(r.loot), captured: sum(r.captured), spoils: r.spoils?.length ?? 0 };
}

describe('NPC camps by level', () => {
	it('how often tier-1 armies of each size win (3+ lanes), what they lose and bring on average', async () => {
		const TRIES = 6;
		const lines: string[] = [];
		for (const kind of ['npc-outpost', 'npc-fortress'])
			for (let level = 1; level <= 3; level++) {
				const row: string[] = [];
				for (let n = 1000; n <= 64000; n *= 2) {
					let wins = 0;
					let lost = 0;
					let gain = 0;
					for (let t = 0; t < TRIES; t++) {
						const r = await attack(kind, level, n);
						if (r.won >= 3) wins++;
						lost += r.lost;
						gain += r.loot + r.captured * 100;
					}
					row.push(
						`${n}: wins ${wins}/${TRIES}, lost ${Math.round(lost / TRIES)} (${Math.round((lost / TRIES / n) * 100)}%), gain ${Math.round(gain / TRIES)}`,
					);
					if (wins === TRIES && lost === 0) break;
				}
				lines.push(`${kind} ${level}:\n  ${row.join('\n  ')}`);
			}
		throw new Error(lines.join('\n'));
	});
});
