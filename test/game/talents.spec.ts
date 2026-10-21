/** Talents (2026-10-21): totals x2, the music house's even spread, and the migration doubling existing heroes'. */
import { describe, expect, it } from 'vitest';
import type { HeroInfo } from '../../src/shared/api';
import migration from '../../migrations/0030_heroes_talents_double.sql?raw';
import { T0, db, inner, player } from '../helpers';

const ATTRS = ['might', 'leadership', 'strategy', 'governance', 'learning', 'charm'];
/** Run the migration's statements (on every row there: each test checks its own). */
const migrate = () =>
	db.batch(
		migration
			.split('\n')
			.filter((l) => !l.trim().startsWith('--'))
			.join('\n')
			.split(/;\s*(?:\n|$)/)
			.map((x) => x.trim())
			.filter(Boolean)
			.map((x) => db.prepare(x)),
	);

describe('talents', () => {
	it('music-house heroes get 1-3 points in every attribute a level, 6-18 in all', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'gold']) await p.grant(T0, r, 5000);
		await p.construct(T0, c.id, inner(c).id, 0, 'music-house');
		const at = T0 + 1_000;
		for (let i = 0; i < 12; i++) await p.run(at, 'heroes.gift', { settlement: c.id, venue: 'music-house' }, true);
		const house = (await p.candidates(at)).find((v) => v.venue === 'music-house')!;
		const gifts = house.candidates.filter((x) => x?.gift);
		expect(gifts.length).toBe(12);
		for (const g of gifts) {
			for (const a of ATTRS) {
				expect(g!.talents![a]).toBeGreaterThanOrEqual(1);
				expect(g!.talents![a]).toBeLessThanOrEqual(3);
			}
			const total = Object.values(g!.talents!).reduce((x, y) => x + y, 0);
			expect(total).toBeGreaterThanOrEqual(6);
			expect(total).toBeLessThanOrEqual(18);
		}
	});

	it('the migration doubles existing talents and makes up the levels already gained', async () => {
		const playerId = crypto.randomUUID();
		const row = (id: string, level: number, attrs: object, talent: number, talents: object | null, alloc: object = {}) =>
			db
				.prepare(
					`INSERT INTO heroes_heroes (id, player_id, surname, given, gender, origin, attrs, home, created_at, level, talent, talents, alloc)
					 VALUES (?, ?, 's:x', 'm:x', 'm', 'tavern', ?, 'nowhere', ?, ?, ?, ?, ?)`,
				)
				.bind(id, playerId, JSON.stringify(attrs), T0, level, talent, talents ? JSON.stringify(talents) : null, JSON.stringify(alloc));
		const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		const gift = crypto.randomUUID();
		await db.batch([
			// Level 5 with a split talent and 4 spent points: +4 x its old talent per attribute.
			row(a, 5, { might: 50, leadership: 40, charm: 20 }, 5, { might: 3, leadership: 2 }, { might: 4 }),
			// From before the split: 3 a level, 2 levels gained = 6 points, by natural attributes (might 30, charm 20).
			row(b, 3, { might: 40, charm: 20 }, 3, null, { might: 10 }),
			// Level 1: nothing to make up.
			row(c, 1, { might: 40 }, 4, { might: 4 }),
			db
				.prepare('INSERT INTO heroes_gifts (id, settlement_id, venue, draft, created_at) VALUES (?, ?, ?, ?, ?)')
				.bind(gift, 'nowhere', 'tavern', JSON.stringify({ surname: 's:x', talents: { might: 1, learning: 4 } }), T0),
		]);
		await migrate();

		const read = async (id: string) => {
			const r = (await db.prepare('SELECT attrs, talent, talents FROM heroes_heroes WHERE id = ?').bind(id).first<{
				attrs: string;
				talent: number;
				talents: string | null;
			}>())!;
			return { attrs: JSON.parse(r.attrs), talent: r.talent, talents: r.talents ? JSON.parse(r.talents) : null };
		};
		expect(await read(a)).toEqual({ attrs: { might: 62, leadership: 48, charm: 20 }, talent: 10, talents: { might: 6, leadership: 4 } });
		expect(await read(b)).toEqual({ attrs: { might: 44, charm: 22 }, talent: 6, talents: null });
		expect(await read(c)).toEqual({ attrs: { might: 40 }, talent: 8, talents: { might: 8 } });
		const draft = await db.prepare('SELECT draft FROM heroes_gifts WHERE id = ?').bind(gift).first<{ draft: string }>();
		expect(JSON.parse(draft!.draft).talents).toEqual({ might: 2, learning: 8 });
		// Browsers' stamps and derived values that read heroes are worked out again.
		const lock = await db
			.prepare('SELECT version FROM engine_locks WHERE entity = ?')
			.bind(`player:${playerId}#heroes_heroes`)
			.first<{ version: number }>();
		expect(lock?.version).toBe(1);
	});

	it('a migrated heroine keeps her accessory slots: written on her from the old talent table, the talent then doubled', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'gold']) await p.grant(T0, r, 5000);
		await p.construct(T0, c.id, inner(c).id, 0, 'music-house');
		const at = T0 + 1_000;
		await p.run(at, 'heroes.gift', { settlement: c.id, venue: 'music-house' }, true);
		const gift = (await p.candidates(at)).find((v) => v.venue === 'music-house')!.candidates.find((x) => x?.gift)!;
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'music-house', gift: gift.gift });
		const her = ((await p.views(at, ['heroes.list']))['heroes.list'] as HeroInfo[])[0];
		// Talent totals before 2026-10-21 and the slots the old table gave them (4: 1, 5: 2, 6: 3, 7: 5, 8: 7, 9: 10).
		for (const [old, slots] of [
			[4, 1],
			[5, 2],
			[6, 3],
			[7, 5],
			[8, 7],
			[9, 10],
		]) {
			const talents = Object.fromEntries(ATTRS.map((a, i) => [a, i < old % 6 ? Math.ceil(old / 6) : Math.floor(old / 6)]));
			await db
				.prepare('UPDATE heroes_heroes SET talent = ?, talents = ?, extras = NULL WHERE id = ?')
				.bind(old, JSON.stringify(talents), her.id)
				.run();
			await migrate();
			const bag = await p.bag(at);
			expect([old, bag.groups[her.id].accessory]).toEqual([old, slots]);
		}
	});

	it('a new heroine rolls her accessory slots by venue (as many as before, at most 10), whatever her talent', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'gold']) await p.grant(T0, r, 1e6);
		await p.construct(T0, c.id, inner(c).id, 0, 'music-house');
		const at = T0 + 1_000;
		const seen = new Set<number>();
		for (let i = 0; i < 40; i++) {
			await p.run(at, 'heroes.gift', { settlement: c.id, venue: 'music-house' }, true);
			const gift = (await p.candidates(at)).find((v) => v.venue === 'music-house')!.candidates.find((x) => x?.gift)!;
			await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'music-house', gift: gift.gift });
			const her = ((await p.views(at, ['heroes.list']))['heroes.list'] as HeroInfo[]).at(-1)!;
			seen.add((await p.bag(at)).groups[her.id].accessory);
			await p.run(at, 'heroes.dismiss', { hero: her.id });
		}
		expect([...seen].every((n) => Number.isInteger(n) && n >= 1 && n <= 10)).toBe(true);
		expect(seen.size).toBeGreaterThan(2);
	});
});
