// A hero's first week of adventures, played for real through the engine (1.3.3 balancing; user 2026-10-06: "英雄冒险的
// 数据有没有测？"): one tavern hero, always on the best task it clears (margin >= 1 with its real stats), healed when
// hurt, free points into might and leadership, the best gear it finds worn, keys used to open the next realm. Prints
// per day: level, realms open, adventures and losses, injuries and what healing cost, experience, and what dropped.
import { describe, it } from 'vitest';
import { resolveConfig } from '../../src/kernel';
import type { EquipmentBag, HeroInfo, ItemStack, MailInbox, RealmMail, RealmsOverview } from '../../src/shared/api';
import { margin } from '../../src/shared/realms';
import { defaultKernel, inner, player, T0 } from '../helpers';

const H = 3600_000;
const real = resolveConfig(defaultKernel, {}).values;
const asPlayed = Object.fromEntries(
	['starter-content.baseProduction', 'terrain.bonus', 'buildings.productionMultiplier'].map((k) => [k, real[k]]),
);
const ADV = ['adv.attack', 'adv.defense', 'adv.hp', 'adv.recovery'];

async function week(tavernLevel: number, checkEvery = 0) {
	const p = player({ ...asPlayed, 'buildings.speed': 1e6 });
	const c = await p.start();
	for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(T0, r, 1e6);
	await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
	await p.run(T0 + 1000, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level: tavernLevel }, true);
	let now = T0 + 2000;
	await p.run(now, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
	const heroOf = async () => ((await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[])[0];
	const hero = (await heroOf()).id;
	const seen = new Set<string>();
	const day = { adventures: 0, lost: 0, injuries: 0, exp: 0, heal: 0, items: 0, drops: new Map<string, number>() };
	const lines: string[] = [];
	let nextDay = 1;
	while (now < T0 + 7 * 24 * H) {
		// Points into might and leadership; the best gear for each slot.
		const h = await heroOf();
		if (h.freePoints > 0) {
			const half = Math.floor(h.freePoints / 2);
			await p.run(now, 'heroes.allocate', { hero, points: { might: h.freePoints - half, leadership: half } });
		}
		const bag = (await p.views(now, ['equipment.bag']))['equipment.bag'] as EquipmentBag;
		const score = (x: EquipmentBag['pieces'][number]) => ADV.reduce((a, k) => a + (x.stats[k] ?? 0) * (k === 'adv.hp' ? 0.1 : 1), 0);
		const bySlot = new Map<string, EquipmentBag['pieces'][number]>();
		for (const piece of bag.pieces)
			if (!piece.minLevel || piece.minLevel <= h.level)
				if (!bySlot.has(piece.slot) || score(piece) > score(bySlot.get(piece.slot)!)) bySlot.set(piece.slot, piece);
		for (const piece of bySlot.values())
			if (piece.hero !== hero) await p.run(now, 'equipment.equip', { piece: piece.id, hero }).catch(() => {});
		// Keys open the next realm.
		const items = (await p.views(now, ['items.inventory']))['items.inventory'] as ItemStack[];
		for (const k of items.filter((i) => i.id.startsWith('realm-key-')))
			await p.run(now, `items.use.${k.id}`, { action: 'unlock' }).catch(() => {});

		const o = (await p.views(now, ['realms.overview']))['realms.overview'] as RealmsOverview;
		const hurt = o.injured.find((x) => x.hero === hero);
		if (hurt) {
			if (hurt.healingUntil === null) {
				day.heal += Object.values(hurt.cost).reduce((a, b) => a + b, 0);
				await p.run(now, 'realms.heal', { hero });
				continue;
			}
			now = hurt.healingUntil + 1000;
			await p.run(now, 'realms.sync').catch(() => {});
		} else {
			const stats = o.heroStats[hero];
			let best: { realm: string; task: number; perSecond: number } | null = null;
			for (const r of o.realms.filter((x) => x.unlocked))
				for (const t of r.tasks) {
					const perSecond = t.exp.reduce((a, b) => a + b, 0) / (t.groups.length * o.groupSeconds);
					if (margin(stats, t.groups, o.minDamage) >= o.outlook.even && (!best || perSecond > best.perSecond))
						best = { realm: r.id, task: t.index, perSecond };
				}
			best ??= { realm: o.realms[0].id, task: 0, perSecond: 0 };
			await p.run(now, 'realms.adventure', { hero, realm: best.realm, task: best.task });
			const adv = ((await p.views(now, ['realms.overview']))['realms.overview'] as RealmsOverview).adventures.find((a) => a.hero === hero)!;
			now = adv.finishesAt + 1000;
			// A player who looks in every few hours starts the next one only then.
			if (checkEvery) now = T0 + Math.ceil((now - T0) / (checkEvery * H)) * checkEvery * H;
			await p.run(now, 'realms.sync');
			for (const m of ((await p.views(now, ['mail.inbox']))['mail.inbox'] as MailInbox).messages) {
				if (seen.has(m.id) || m.kind !== 'realms.report') continue;
				seen.add(m.id);
				const r = m.data as RealmMail;
				day.adventures++;
				if (!r.cleared) day.lost++;
				if (r.injured) day.injuries++;
				day.exp += r.exp;
				day.items += r.groups.reduce((a, g) => a + g.rewards.filter((x) => x.kind !== 'exp').length, 0);
				for (const line of [...r.groups.flatMap((g) => g.rewards), ...r.clearRewards]) {
					const name = typeof line.name === 'string' ? line.name : JSON.stringify(line.name);
					day.drops.set(name, (day.drops.get(name) ?? 0) + (line.count ?? 1));
				}
			}
		}
		if (now >= T0 + nextDay * 24 * H) {
			const h2 = await heroOf();
			const open = o.realms.filter((x) => x.unlocked).length;
			const drops = [...day.drops].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n.replace(/^.*\./, '')} ${k}`);
			lines.push(
				`day ${nextDay}: hero lv ${h2.level}, realms open ${open}, adventures ${day.adventures} (lost ${day.lost}, hurt ${day.injuries}, healing ${day.heal}), exp ${day.exp}, ${(day.items / Math.max(1, day.adventures)).toFixed(1)} drops an adventure\n    drops: ${drops.join(', ')}`,
			);
			Object.assign(day, { adventures: 0, lost: 0, injuries: 0, exp: 0, heal: 0, items: 0, drops: new Map() });
			nextDay++;
		}
	}
	return lines;
}

describe('adventures', () => {
	it.each([
		[1, 0],
		[1, 3],
		[10, 0],
	])('a tavern hero (tavern level %s), looked after every %s hours (0: at once), first week', async (tavernLevel, every) => {
		throw new Error(`tavern ${tavernLevel}, every ${every} h\n${(await week(tavernLevel, every)).join('\n')}`);
	});
});
