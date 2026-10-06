// A new player's first week, played greedily (user 2026-10-05: "做一些模拟试玩，统筹优化一下默认数值设计"): building
// only, and building with an army raiding the starter camps (test/sim/bot.ts). Prints where the player stands at each
// checkpoint, and how much of the time a construction slot sat idle for want of resources.
import { describe, it } from 'vitest';
import { play, type Report } from './bot';

const HOURS = [1, 3, 6, 12, 24, 48, 72, 120, 168];
const show = (r: Report, army: boolean) =>
	`${r.hour}h: built ${r.built}, research ${r.researched}, outer +${r.outers}, idle ${r.idle}%, cap ${r.capacity}, per hour ${JSON.stringify(r.perHour)}` +
	(army ? `\n    army ${r.army}, upkeep ${r.upkeepPerHour}/h, raids ${r.raids}, raided ${r.raidGains}, captured ${r.captured}` : '') +
	`\n    levels ${JSON.stringify(r.levels)}`;

describe('first week', () => {
	it.each([false, true])('a greedy player, army %s', async (army) => {
		const reports = await play(HOURS, { army });
		throw new Error(`army ${army}\n${reports.map((r) => show(r, army)).join('\n')}`);
	});
});
