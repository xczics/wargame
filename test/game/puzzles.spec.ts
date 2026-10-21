/** Puzzles: pieces drop in battles where the GM aims them; a completed picture brings what the GM says. */
import { afterEach, describe, expect, it } from 'vitest';
import { wrap } from '../../src/plugins/world-map';
import type { DefenseMail, PuzzleAlbumEntry, PuzzleDefData, PuzzleInfo, PuzzleProgress } from '../../src/shared/api';
import type { CardsData } from '../../src/shared/ui';
import { db, defaultKernel, T0, inbox, player } from '../helpers';

const fight = {
	'armies.speed': 1e6,
	'armies.minSeconds': 0,
	'npc-camps.levels': { 'npc-outpost': { 1: { stockade: 0, lane: { 1: 1 }, loot: { total: 0 } } } },
	// The camps' own loot pool is empty: what drops here is the puzzles'.
};
const puzzle = (over: Partial<PuzzleDefData> = {}): Omit<PuzzleDefData, 'id'> & { id?: string } => ({
	name: 'Spring Garden',
	grid: 2,
	status: 'live',
	image: null,
	limit: 1,
	duplicate: { kind: 'resources', config: { food: 10 } },
	// Every piece on every outpost raid, for sure: the test sees all four at once.
	drops: [{ pieces: [0, 1, 2, 3], sites: ['npc-camps/npc-outpost'], chance: 1, value: 0 }],
	rewards: [{ kind: 'resources', config: { gold: 100 } }],
	...over,
});

async function setup(extra: Record<string, unknown> = {}) {
	const p = player({ ...fight, ...extra });
	const c = await p.start();
	await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-2', count: 200 }, true);
	const camp = { x: wrap(c.x + 5), y: c.y };
	await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp, level: 1 }, true);
	let t = T0;
	const raid = async () => {
		t += 10_000;
		await p.run(t, 'armies.send', { from: c.id, ...camp, units: { 'cavalry-2': 20 } });
		await p.run(t + 1_500, 'armies.sync');
		return t + 1_500;
	};
	const mine = async (at: number) => (await p.views(at, ['puzzles.mine']))['puzzles.mine'] as PuzzleProgress[];
	const id = async (name: string) =>
		(await db.prepare('SELECT id FROM puzzles_defs WHERE name = ? ORDER BY updated_at DESC').bind(name).first<{ id: string }>())!.id;
	return { p, c, raid, mine, id };
}

describe('puzzles', () => {
	// Puzzles are the world's, not a player's: each test's are taken down after it, so the next one's raids drop only its own.
	afterEach(async () => void (await db.prepare("UPDATE puzzles_defs SET status = 'hidden'").run()));
	it('the report names which piece of which puzzle; equipment as a reward is a real piece, refused (pieces kept) when there is no room', async () => {
		const { p, raid, mine, id } = await setup({ 'equipment.storage': 0 });
		await p.run(
			T0,
			'puzzles.save',
			puzzle({ name: 'Armoury', rewards: [{ kind: 'equipment', config: { set: 'azure-edge', rarity: 'gold' } }] }),
			true,
		);
		const pid = await id('Armoury');
		const at = await raid();
		const spoils = (
			(await p.views(at, ['armies.list']))['armies.list'] as {
				report?: { spoils?: { label?: { text: string; vars?: Record<string, unknown> } }[] };
			}[]
		)
			.flatMap((a) => a.report?.spoils ?? [])
			.map((l) => l.label);
		expect(spoils).toContainEqual({
			text: 'puzzles.Piece {0} of "{1}"',
			vars: { 0: 'A1', 1: { text: 'i18n.{0}', vars: { 0: 'Armoury' } } },
		});
		// No room in the capital's storage: the claim is refused, the pieces stay.
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid })).rejects.toThrow(/room/);
		expect((await mine(at)).find((x) => x.id === pid)!.pieces).toHaveLength(4);
	});

	it("a beaten band always rolls: pieces drop even when the bandits' own drop chance says no", async () => {
		const p = player({ ...fight, 'bandits.rules': { drops: { chance: 0 } } });
		const c = await p.start();
		await p.run(T0, 'prestige.grant', { amount: 60 }, true);
		for (const u of ['infantry-3', 'archer-3', 'cavalry-3'])
			await p.run(T0, 'troops.grant', { settlement: c.id, unit: u, count: 500 }, true);
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Outlaws', drops: [{ pieces: [0], sites: ['bandits'], chance: 1, value: 0 }] }), true);
		await p.run(T0, 'bandits.spawn', { settlement: c.id }, true);
		const [band] = (await p.views(T0, ['armies.incoming']))['armies.incoming'] as { arrivesAt: number }[];
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.outcome).toBe('defeat'); // the attackers'
		expect(report.rewards?.map((r) => r.name)).toEqual(['puzzles.Puzzle piece']);
	});

	it('pieces drop where the GM aims them, one more of it each time; any of them is exchanged on the Items page, asked first', async () => {
		const { p, raid, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle(), true);
		const pid = await id('Spring Garden');
		let at = await raid();
		expect((await mine(at)).find((x) => x.id === pid)).toEqual({ id: pid, pieces: [0, 1, 2, 3], claims: 0, spares: 0 });
		// On the Items page: the card opens on its pieces, how many of each; every one can be exchanged (asked first). No
		// picture: the tiles keep the icon.
		const cardOf = async () =>
			((await p.views(at, ['items.cards']))['items.cards'] as CardsData).cards.find((c) => c.id === `puzzle:${pid}`)!;
		const held = await cardOf();
		expect(held.detail!.tiles!.map((t) => [t.id, t.count])).toEqual([0, 1, 2, 3].map((i) => [`piece:${pid}:${i}`, 1]));
		expect(held.detail!.tiles!.every((t) => !t.actions![0].blocked && t.actions![0].confirm && !t.picture)).toBe(true);
		// With a picture: each piece its own cut of it; the card keeps its icon.
		const image = 'puzzles/0123456789abcdef0123.webp';
		const def = (await db.prepare('SELECT * FROM puzzles_defs WHERE id = ?').bind(pid).first<Record<string, unknown>>())!;
		await p.run(at, 'puzzles.save', { ...puzzle(), id: pid, image, status: def.status }, true);
		const pictured = await cardOf();
		expect(pictured.picture).toBeUndefined();
		expect(pictured.detail!.tiles!.map((t) => t.picture)).toEqual([0, 1, 2, 3].map((piece) => ({ file: image, grid: 2, piece })));

		// A second round: one more of each (the report says how many now); nothing given on the spot.
		at = await raid();
		const spoils = ((await p.views(at, ['armies.list']))['armies.list'] as { report?: { spoils?: { name: string; count?: number }[] } }[])
			.flatMap((a) => a.report?.spoils ?? [])
			.map((l) => l.name);
		expect(spoils.filter((n) => n === 'puzzles.Puzzle piece')).toHaveLength(4);
		expect(spoils.filter((n) => n === 'starter-content.Food')).toHaveLength(0);
		expect((await mine(at)).find((x) => x.id === pid)).toMatchObject({ pieces: [0, 1, 2, 3], spares: 4 });
		expect((await cardOf()).detail!.tiles!.map((t) => t.count)).toEqual([2, 2, 2, 2]);

		// Claiming the picture takes one of each.
		const before = (await p.pool(at)).amounts;
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(before.gold + 100);
		expect((await mine(at)).find((x) => x.id === pid)).toEqual({ id: pid, pieces: [0, 1, 2, 3], claims: 1, spares: 0 });
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid })).rejects.toThrow(/as often as allowed/);

		// Exchanging: whichever piece is clicked, one of it (10 food); none left: refused.
		const exchange = (await cardOf()).detail!.tiles![0].actions![0];
		expect(exchange).toMatchObject({ command: 'puzzles.exchange', payload: { puzzle: pid, piece: 0 } });
		const food = async () => (await p.pool(at)).amounts.food;
		const was = await food();
		await p.run(at, 'puzzles.exchange', exchange.payload);
		expect(await food()).toBeCloseTo(was + 10);
		expect((await mine(at)).find((x) => x.id === pid)).toMatchObject({ pieces: [1, 2, 3], spares: 0 });
		await expect(p.run(at, 'puzzles.exchange', { puzzle: pid, piece: 0 })).rejects.toThrow(/No piece/);
		expect((await cardOf()).detail!.tiles!.map((t) => t.id)).toEqual([1, 2, 3].map((i) => `piece:${pid}:${i}`));
	});

	it('exchanges several of a piece at once (asked how many on the Items page), never more than there are', async () => {
		const { p, raid, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Batch Garden' }), true);
		const pid = await id('Batch Garden');
		await raid();
		const at = await raid(); // two of each
		const card = ((await p.views(at, ['items.cards']))['items.cards'] as CardsData).cards.find((c) => c.id === `puzzle:${pid}`)!;
		const [one, several] = card.detail!.tiles![0].actions!;
		expect(one).toMatchObject({ label: { text: 'starter-puzzles.Exchange' }, payload: { puzzle: pid, piece: 0 } });
		expect(several).toMatchObject({ label: { text: 'starter-puzzles.Exchange several' }, quantity: { max: 2 } });
		await expect(p.run(at, 'puzzles.exchange', { puzzle: pid, piece: 0, count: 3 })).rejects.toThrow(/Only \{0\} of piece/);
		const food = async () => (await p.pool(at)).amounts.food;
		const was = await food();
		await p.run(at, 'puzzles.exchange', { puzzle: pid, piece: 0, count: 2 });
		expect(await food()).toBeCloseTo(was + 20);
		expect((await mine(at)).find((x) => x.id === pid)).toMatchObject({ pieces: [1, 2, 3], spares: 3 });
	});

	it("a puzzle's description from the GM: in the catalog players get (as written), none when empty", async () => {
		const { p, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Told Garden', description: '  Spring comes.\nCollect them all.  ' }), true);
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Plain Garden' }), true);
		const statics = defaultKernel.statics.find((x) => x.id === 'puzzles.catalog')!;
		const catalog = (await statics.compute({ rules: { config: p.overrides }, db } as never)) as Record<string, PuzzleInfo>;
		expect(catalog[await id('Told Garden')].description).toBe('Spring comes.\nCollect them all.');
		expect(catalog[await id('Plain Garden')]).not.toHaveProperty('description');
	});

	it('permanent defence: the player picks one of their settlements on claiming; it shows on the wall', async () => {
		const { p, c, raid, id } = await setup();
		const reward = { kind: 'defense', config: { amount: 300 } };
		// Not as a duplicate's reward (given in a battle: nobody to pick a settlement).
		await expect(p.run(T0, 'puzzles.save', puzzle({ name: 'Bastion', duplicate: reward }), true)).rejects.toThrow(/duplicate/);
		await expect(
			p.run(T0, 'puzzles.save', puzzle({ name: 'Bastion', rewards: [{ kind: 'defense', config: { amount: 0 } }] }), true),
		).rejects.toThrow();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Bastion', rewards: [reward] }), true);
		const pid = await id('Bastion');
		const statics = defaultKernel.statics.find((x) => x.id === 'puzzles.catalog')!;
		const catalog = (await statics.compute({ rules: { config: p.overrides }, db } as never)) as Record<string, PuzzleInfo>;
		expect(catalog[pid].chooseSettlement).toBe(true);
		const at = await raid();
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid })).rejects.toThrow(/Choose a settlement/);
		const other = player();
		const theirs = await other.start();
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid, settlement: theirs.id })).rejects.toThrow(/No such settlement/);
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid, settlement: 'bad id!' })).rejects.toThrow();
		await p.run(at, 'puzzles.claim', { puzzle: pid, settlement: c.id });
		const row = await db
			.prepare('SELECT defense FROM starter_defense_permanent WHERE settlement_id = ?')
			.bind(c.id)
			.first<{ defense: number }>();
		expect(row!.defense).toBe(300);
		expect(await db.prepare('SELECT 1 FROM starter_defense_permanent WHERE settlement_id = ?').bind(theirs.id).first()).toBeNull();
		const cards = ((await p.shown(at, ['buildings.slots'], { settlement: c.id }))['buildings.slots'] as CardsData).cards;
		const wall = cards.find((x) => JSON.stringify(x.title).includes('"starter-defense.Wall"'))!;
		expect(JSON.stringify(wall.lines)).toContain('starter-defense.Permanent defence +{0} in every lane (after every bonus)');
	});

	it('drops only where aimed, and only while live', async () => {
		const { p, raid, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Elsewhere', drops: [{ pieces: [0], sites: ['realms'], chance: 1, value: 0 }] }), true);
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Sketch', status: 'draft' }), true);
		const at = await raid();
		const ids = (await mine(at)).map((x) => x.id);
		expect(ids).not.toContain(await id('Elsewhere'));
		expect(ids).not.toContain(await id('Sketch'));
	});

	it('checks what the GM writes: pieces within the grid, known rewards, the grid fixed once out of the draft', async () => {
		const { p, id } = await setup();
		await expect(
			p.run(T0, 'puzzles.save', puzzle({ drops: [{ pieces: [4], sites: ['npc-camps'], chance: 1, value: 0 }] }), true),
		).rejects.toThrow(/Pieces go up to/);
		await expect(p.run(T0, 'puzzles.save', puzzle({ rewards: [{ kind: 'nope', config: {} }] }), true)).rejects.toThrow(
			/Unknown reward kind/,
		);
		await expect(p.run(T0, 'puzzles.save', puzzle(), false)).rejects.toThrow(/Unknown command/);
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Fixed' }), true);
		const pid = await id('Fixed');
		await expect(p.run(T0, 'puzzles.save', { ...puzzle({ name: 'Fixed', grid: 3 }), id: pid }, true)).rejects.toThrow(/grid is fixed/);
		// A pool of rewards: one of them, by weight.
		await p
			.run(
				T0,
				'puzzles.save',
				puzzle({
					name: 'Lucky',
					rewards: [
						{
							kind: 'pool',
							config: {
								options: [
									{ weight: 1, kind: 'resources', config: { gold: 5 } },
									{ weight: 1, kind: 'pool', config: {} },
								],
							},
						},
					],
				}),
				true,
			)
			.catch((e) => expect(String(e)).toMatch(/pool inside a pool/));
	});

	it('a heroine as the reward comes past the hero limit (user 2026-10-20); recruiting still stops at it', async () => {
		const { p, c, raid, id } = await setup({ 'heroes.cap': 0 });
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Beauty', rewards: [{ kind: 'hero-female', config: { venue: 'music-house' } }] }), true);
		const pid = await id('Beauty');
		const at = await raid();
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		const heroes = defaultKernel.services.get('heroes');
		const api = { db, memo: (_k: string, f: () => unknown) => f(), playerId: p.id, now: at } as never;
		expect(await heroes.list(api, p.id)).toHaveLength(1);
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 })).rejects.toThrow();
	});

	it('the GM gives pieces (all, or the ones named); players cannot; a piece the puzzle lacks is refused', async () => {
		const { p, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Gift' }), true);
		const pid = await id('Gift');
		await p.run(T0, 'puzzles.grant', { puzzle: pid, count: 2 }, true);
		expect((await mine(T0)).find((x) => x.id === pid)).toMatchObject({ pieces: [0, 1, 2, 3], spares: 4 });
		await p.run(T0, 'puzzles.grant', { puzzle: pid, pieces: 'b2, A1', count: 1 }, true);
		expect((await mine(T0)).find((x) => x.id === pid)!.spares).toBe(6);
		await expect(p.run(T0, 'puzzles.grant', { puzzle: pid, pieces: 'C3', count: 1 }, true)).rejects.toThrow(/No piece/);
		await expect(p.run(T0, 'puzzles.grant', { puzzle: pid, count: 1 })).rejects.toThrow();
	});

	it('the album keeps what was completed with its first day; retired ones stay there, out of print; old claims have no day', async () => {
		const { p, raid, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Album', limit: 2 }), true);
		const pid = await id('Album');
		const at = await raid();
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		const album = async (now: number) => (await p.views(now, ['puzzles.album']))['puzzles.album'] as PuzzleAlbumEntry[];
		expect(await album(at)).toEqual([{ id: pid, claims: 1, firstAt: at }]);
		// A second claim keeps the first day.
		const again = await raid();
		await p.run(again, 'puzzles.claim', { puzzle: pid });
		expect(await album(again)).toEqual([{ id: pid, claims: 2, firstAt: at }]);
		// Retired by the GM: gone from the board, kept in the album and in the catalog, sealed out of print.
		await p.run(again, 'puzzles.save', { ...puzzle({ name: 'Album', limit: 2, status: 'hidden' }), id: pid }, true);
		expect((await mine(again)).find((x) => x.id === pid)).toBeUndefined();
		expect((await album(again)).map((x) => x.id)).toEqual([pid]);
		const statics = defaultKernel.statics.find((x) => x.id === 'puzzles.catalog')!;
		const catalog = (await statics.compute({ rules: { config: p.overrides }, db } as never)) as Record<string, PuzzleInfo>;
		expect(catalog[pid]).toMatchObject({ outOfPrint: true, retired: true, dropping: false });
		// A claim from before the day was kept.
		await db.prepare('UPDATE puzzles_claims SET first_at = NULL WHERE player_id = ? AND puzzle_id = ?').bind(p.id, pid).run();
		expect(await album(again + 1)).toEqual([{ id: pid, claims: 2, firstAt: null }]);
	});

	it("a GM's hero keeps the attributes as the form has them (shown again when edited later), older ones still read", async () => {
		const { p, raid, id } = await setup();
		const [a, b] = defaultKernel.services.get('heroes').attributes();
		const config = { venue: 'music-house', gender: 'any', [`attr:${a.id}`]: 77, [`attr:${b.id}`]: 55 };
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Talent', rewards: [{ kind: 'hero', config }] }), true);
		const pid = await id('Talent');
		const row = await db.prepare('SELECT rewards FROM puzzles_defs WHERE id = ?').bind(pid).first<string>('rewards');
		expect(JSON.parse(row!)).toEqual([{ kind: 'hero', config }]);
		// Saved before as { attrs }: read into the form's fields.
		const rewards = defaultKernel.services.get('rewards');
		expect(rewards.check({ kind: 'hero', config: { venue: 'music-house', gender: 'any', attrs: { [a.id]: 77, [b.id]: 55 } } })).toEqual({
			kind: 'hero',
			config,
		});
		// Claimed: the hero has them.
		const at = await raid();
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		const heroes = (await p.views(at, ['heroes.list']))['heroes.list'] as { attrs: Record<string, number> }[];
		expect(heroes.at(-1)!.attrs).toMatchObject({ [a.id]: 77, [b.id]: 55 });
	});
	it("a GM's hero: talents per attribute in place of the drawn ones, a heroine's number of accessories; bad values refused", async () => {
		const { p, raid, id } = await setup();
		const [a, b] = defaultKernel.services.get('heroes').attributes();
		const rewards = defaultKernel.services.get('rewards');
		const base = { venue: 'music-house', gender: 'f' };
		for (const bad of [
			{ [`talent:${a.id}`]: 1.5 },
			{ [`talent:${a.id}`]: -1 },
			{ [`talent:${a.id}`]: 101 },
			{ accessories: 13 },
			{ accessories: 'x' },
		])
			expect(() => rewards.check({ kind: 'hero', config: { ...base, ...bad } })).toThrow();
		const config = { ...base, [`talent:${a.id}`]: 6, [`talent:${b.id}`]: 0, accessories: 12 };
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Gifted', rewards: [{ kind: 'hero', config }] }), true);
		const pid = await id('Gifted');
		// Kept as the form has it: the editor shows the values again.
		const row = await db.prepare('SELECT rewards FROM puzzles_defs WHERE id = ?').bind(pid).first<string>('rewards');
		expect(JSON.parse(row!)).toEqual([{ kind: 'hero', config }]);
		const at = await raid();
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		const list = (await p.views(at, ['heroes.list']))['heroes.list'] as { id: string; talent: number; talents: Record<string, number> }[];
		const hero = list.at(-1)!;
		// Only the GM's: the empty ones have none.
		expect(hero.talents).toEqual({ [a.id]: 6 });
		expect(hero.talent).toBe(6);
		// A talent of 6 wears 3; the GM said 12.
		const bag = (await p.views(at, ['equipment.bag']))['equipment.bag'] as { groups: Record<string, Record<string, number>> };
		expect(bag.groups[hero.id].accessory).toBe(12);
	});
});

export type { PuzzleInfo };
