/** Puzzles: pieces drop in battles where the GM aims them; a completed picture brings what the GM says. */
import { afterEach, describe, expect, it } from 'vitest';
import { wrap } from '../../src/plugins/world-map';
import type { DefenseMail, PuzzleDefData, PuzzleInfo, PuzzleProgress } from '../../src/shared/api';
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

	it('pieces drop where the GM aims them; a complete picture is claimed once, then pieces turn into the duplicate reward', async () => {
		const { p, raid, mine, id } = await setup();
		await p.run(T0, 'puzzles.save', puzzle(), true);
		const pid = await id('Spring Garden');
		let at = await raid();
		expect((await mine(at)).find((x) => x.id === pid)).toEqual({ id: pid, pieces: [0, 1, 2, 3], claims: 0 });

		const before = (await p.pool(at)).amounts;
		await p.run(at, 'puzzles.claim', { puzzle: pid });
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(before.gold + 100);
		expect((await mine(at)).find((x) => x.id === pid)).toEqual({ id: pid, pieces: [], claims: 1 });
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid })).rejects.toThrow(/missing/);

		// Claimed as often as allowed: every piece that drops now is a duplicate (10 food each).
		at = await raid();
		// (Food also goes to the cavalry's upkeep meanwhile: read the report, not the store.)
		const spoils = ((await p.views(at, ['armies.list']))['armies.list'] as { report?: { spoils?: { name: string; count?: number }[] } }[])
			.flatMap((a) => a.report?.spoils ?? [])
			.map((l) => l.name);
		expect(spoils.filter((n) => n === 'puzzles.Puzzle piece (had it already)')).toHaveLength(4);
		expect(spoils.filter((n) => n === 'starter-content.Food')).toHaveLength(4);
		expect((await mine(at)).find((x) => x.id === pid)!.pieces).toEqual([]);
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

	it('a heroine as the reward; with no room for her the claim is refused and the pieces stay', async () => {
		const { p, c, raid, mine, id } = await setup({ 'heroes.cap': 0 });
		await p.run(T0, 'puzzles.save', puzzle({ name: 'Beauty', rewards: [{ kind: 'hero-female', config: { venue: 'music-house' } }] }), true);
		const pid = await id('Beauty');
		const at = await raid();
		await expect(p.run(at, 'puzzles.claim', { puzzle: pid })).rejects.toThrow(/Hero limit/);
		expect((await mine(at)).find((x) => x.id === pid)!.pieces).toHaveLength(4);
		void c;
	});
});

export type { PuzzleInfo };
