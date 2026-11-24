import type { SiegeRules, SiegeWall, SiegeWallData } from './api';

/**
 * The wall's upkeep in a settlement whose kind keeps it differently (starter-siege rule `kinds`; resource fortresses:
 * user 2026-10-19 "城防设施维护消耗减半，且不再消耗金币…金币的维护消耗部分分摊给其他资源"): the currency share goes
 * to the other resources in their shares (none other: it stays), then everything x `upkeep`. The shares are the whole
 * wall's (`base`, default: this upkeep itself): one defence's row shares its currency out as the wall's total does, so
 * the rows add up to it (user 2026-11-05: "前端根据规则正常显示，和服务端保持一致"). Pure: both ends use it.
 */
export function wallUpkeep(
	upkeep: Record<string, number>,
	kind: { upkeep: number; noGold: number } | null | undefined,
	base: Record<string, number> = upkeep,
): Record<string, number> {
	const out = { ...upkeep };
	if (!kind || !Object.keys(out).length) return out;
	if (kind.noGold && out.gold) {
		const others = Object.keys(base).filter((r) => r !== 'gold' && base[r] > 0);
		const rest = others.reduce((n, r) => n + base[r], 0);
		if (rest > 0) {
			for (const r of others) out[r] = (out[r] ?? 0) + (out.gold * base[r]) / rest;
			delete out.gold;
		}
	}
	for (const r of Object.keys(out)) out[r] *= kind.upkeep;
	return out;
}

/** Upkeep amounts added together (e.g. each defence x how many, each work at its level). */
export function addUpkeep(into: Record<string, number>, upkeep: Record<string, number>, times = 1): Record<string, number> {
	for (const [r, v] of Object.entries(upkeep)) into[r] = (into[r] ?? 0) + v * times;
	return into;
}

/** Build seconds at a wall of level `wall`: each level speeds it up by `wallSpeed` percent (both ends). */
export const wallSeconds = (seconds: number, wall: number, wallSpeed: number) => seconds / (1 + (wall * wallSpeed) / 100);

/** A work's level once everything queued is built: the next order raises it from there (the server's `fortify`). */
export function plannedLevel(d: Pick<SiegeWallData, 'works' | 'queue' | 'waiting'>, work: string): number {
	const queued = [...(d.queue ? [d.queue] : []), ...d.waiting].filter((j) => j.kind === 'work' && j.item === work).map((j) => j.amount);
	return Math.max(d.works[work] ?? 0, ...queued);
}

/**
 * The wall's data (`starter-siege.wall`) with the rules' numbers (static `starter-siege.rules`), as its entry shows it:
 * each work's value now and what its next order builds, each defence's numbers and build time here, the upkeep as
 * charged under the settlement kind's rule (`kind`). The same for the browser and the tests.
 */
export function siegeWallOf(d: SiegeWallData, rules: SiegeRules, kind?: { upkeep: number; noGold: number } | null): SiegeWall {
	const time = (seconds: number) => wallSeconds(seconds, d.wall, rules.wallSpeed);
	const raw: Record<string, number> = {};
	for (const x of rules.deviceDefs) if (d.devices[x.id]) addUpkeep(raw, x.upkeep, d.devices[x.id]);
	for (const w of rules.workDefs) if (d.works[w.id]) addUpkeep(raw, w.levels[d.works[w.id] - 1]?.upkeep ?? {});
	return {
		settlement: d.settlement,
		wall: d.wall,
		works: rules.workDefs.map((w) => {
			const level = d.works[w.id] ?? 0;
			const planned = plannedLevel(d, w.id);
			const n = w.levels[planned];
			return {
				id: w.id,
				name: w.name,
				...(w.icon ? { icon: w.icon } : {}),
				level,
				planned,
				maxLevel: w.levels.length,
				effect: w.effect,
				value: level ? (w.levels[level - 1]?.value ?? 0) : 0,
				next: n ? { value: n.value, cost: n.cost, seconds: n.seconds, time: time(n.seconds), upkeep: n.upkeep } : null,
			};
		}),
		devices: rules.deviceDefs.map((x) => ({
			id: x.id,
			name: x.name,
			...(x.icon ? { icon: x.icon } : {}),
			count: d.devices[x.id] ?? 0,
			stat: x.stat,
			value: x.value,
			wall: x.wall,
			cost: x.cost,
			upkeep: x.upkeep,
			seconds: Math.ceil(x.seconds),
			time: time(x.seconds),
		})),
		queue: d.queue,
		waiting: d.waiting,
		upkeep: Object.keys(raw).length ? wallUpkeep(raw, kind) : raw,
	};
}

/** An order at the wall as the answer tells it (`starter-siege.queued`): its id, and when it ends if it started. */
export interface SiegeQueued {
	id: string;
	finishesAt: number | null;
}

/**
 * An order placed at `now` (`starter-siege.build` / `fortify`), into the wall's data held in the browser: built now when
 * the answer gives its end, else waiting with what it paid (a defence's cost x count; a work's level from the rules).
 */
export function siegeOrdered(
	d: SiegeWallData,
	p: { settlement: string } & ({ device: string; count: number } | { work: string }),
	q: SiegeQueued,
	rules: SiegeRules,
	now: number,
): SiegeWallData | null {
	if (d.settlement !== p.settlement) return d;
	const order =
		'work' in p
			? { kind: 'work' as const, item: p.work, amount: plannedLevel(d, p.work) + 1 }
			: { kind: 'device' as const, item: p.device, amount: p.count };
	const cost =
		order.kind === 'work'
			? rules.workDefs.find((w) => w.id === order.item)?.levels[order.amount - 1]?.cost
			: (() => {
					const c = rules.deviceDefs.find((x) => x.id === order.item)?.cost;
					return c && Object.fromEntries(Object.entries(c).map(([r, n]) => [r, n * order.amount]));
				})();
	if (!cost) return null;
	if (q.finishesAt !== null) return { ...d, queue: { id: q.id, ...order, startedAt: now, finishesAt: q.finishesAt } };
	return { ...d, waiting: [...d.waiting, { id: q.id, ...order, cost }] };
}

/** A waiting order cancelled. */
export const siegeCancelled = (d: SiegeWallData, id: string): SiegeWallData =>
	d.waiting.some((j) => j.id === id) ? { ...d, waiting: d.waiting.filter((j) => j.id !== id) } : d;
