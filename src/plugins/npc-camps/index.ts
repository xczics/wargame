/**
 * NPC settlements to raid (docs/design/gameplay.md §3.12), each of a level 1-10:
 *
 *   npc-fortress  beating it captures some troops
 *   npc-outpost   beating it carries off resources, leaning towards what its tile is good for
 *
 * Everything a level means is data (./data/levels.csv, GM rule `npc-camps.levels`): its name, the
 * stockade (flat defence in every lane), the garrison of each lane by tier (families from a random
 * formation every battle; NPCs never lose troops), the loot, and from level 3 defending heroes
 * (battle bonuses). A world's camps are placed when its map is imported (npc-camps.populate); uprooted ones
 * are replaced elsewhere by a background task (npc-camps.respawn). The GM can place more.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	type EngineApi,
	executeCommand,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import { amount, duration } from '../../shared/format';
import type { BattleReport, RewardLine } from '../../shared/api';
import type { GridCell, UiLine } from '../../shared/ui';
import type { Encounter, SendOrder } from '../armies';
import type { Settlement } from '../settlements';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import starterCsv from './data/starter.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('npc-camps');
const text = uiTexts('npc-camps');

/**
 * The loot pool of NPC settlements: what a raid that wins may find besides the plunder and captives. Empty by
 * default; other plugins fill it with `loot.addDrop<NpcCampOccasion>('npc-camps', ...)`.
 */
const POOL = 'npc-camps';
export interface NpcCampOccasion {
	playerId: string;
	camp: Settlement;
	level: number;
}

const KINDS = ['npc-fortress', 'npc-outpost'] as const;
type Kind = (typeof KINDS)[number];
const LEVELS = 10;
/** Design numbers (./data); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

export interface CampLevel {
	name: string;
	stockade: number;
	/** Each lane's garrison by tier. */
	lane: Record<string, number>;
	/** Outposts: total resources; fortresses: units by tier. */
	loot: Record<string, number>;
	/** Outposts: 0 = even split, 1 = all of the favoured resource. */
	bias: number;
	heroes: number;
	heroAttack: number;
	heroDefense: number;
	heroHp: number;
	heroCasualty: number;
}
const FILE: Record<string, Record<number, CampLevel>> = {};
for (const r of csvRows(levelsCsv)) {
	(FILE[r.kind] ??= {})[csvNumber(r, 'level')] = {
		name: r.name,
		stockade: csvNumber(r, 'stockade'),
		lane: csvMap(r.lane),
		loot: r.kind === 'npc-outpost' ? { total: csvNumber(r, 'loot') } : csvMap(r.loot),
		bias: csvNumber(r, 'bias', 0),
		heroes: csvNumber(r, 'heroes', 0),
		heroAttack: csvNumber(r, 'heroAttack', 0),
		heroDefense: csvNumber(r, 'heroDefense', 0),
		heroHp: csvNumber(r, 'heroHp', 0),
		heroCasualty: csvNumber(r, 'heroCasualty', 0),
	};
}

const tierMap = (raw: unknown, where: string) => {
	if (typeof raw !== 'object' || raw === null) throw fail('bad_config', text('{0}: expected { tier: count }', { 0: where }));
	return Object.fromEntries(
		Object.entries(raw).map(([t, n]) => {
			if (!/^[1-9]\d*$/.test(t) && t !== 'total') throw fail('bad_config', text('{0}: "{1}" is not a tier', { 0: where, 1: t }));
			return [t, Math.floor(numberInRange(0, 1e9)(n))];
		}),
	);
};

export default definePlugin({
	id: 'npc-camps',
	version: '0.2.0',
	description: 'NPC fortresses (raid for troops) and outposts (raid for resources), levels 1-10',
	dependsOn: ['settlements', 'world-map', 'armies', 'resources', 'troops', 'battle', 'terrain', 'heroes', 'loot', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const map = ctx.services.get('worldMap');
		const armies = ctx.services.get('armies');
		const resources = ctx.services.get('resources');
		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');
		const terrain = ctx.services.get('terrain');
		const heroes = ctx.services.get('heroes');

		const levels = ctx.config.define<Record<string, Record<number, CampLevel>>>('levels', {
			description:
				'What each level of each NPC kind means (partial: { "npc-outpost": { "3": { "stockade": 90, "lane": { "1": 25, "2": 5 }, "loot": { "total": 3000 }, "bias": 0.1, "heroes": 1, "heroAttack": 12, ... } } }); see levels.csv. Fortress loot is units by tier.',
			default: () => FILE,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { kind: { level: {...} } }');
				const out = structuredClone(FILE);
				for (const [kind, byLevel] of Object.entries(raw as Record<string, Record<string, Record<string, unknown>>>)) {
					if (!KINDS.includes(kind as Kind)) throw fail('bad_config', text('Unknown NPC kind "{0}"', { 0: kind }));
					for (const [lv, patch] of Object.entries(byLevel ?? {})) {
						const level = Number(lv);
						const where = `${kind}.${lv}`;
						if (!out[kind][level]) throw fail('bad_config', text('{0}: levels are 1-{1}', { 0: where, 1: LEVELS }));
						const row = out[kind][level];
						for (const [k, v] of Object.entries(patch ?? {})) {
							if (k === 'name') {
								if (typeof v !== 'string' || !v) throw fail('bad_config', text('{0}.name must be text', { 0: where }));
								row.name = v;
							} else if (k === 'lane' || k === 'loot') row[k] = tierMap(v, `${where}.${k}`);
							else if (k === 'bias') row.bias = numberInRange(0, 1)(v);
							else if (k in row) (row as unknown as Record<string, number>)[k] = numberInRange(0, 1e12)(v);
							else throw fail('bad_config', text('{0}: unknown field "{1}"', { 0: where, 1: k }));
						}
					}
				}
				return out;
			},
		});
		const spawnWeights = ctx.config.define<Record<string, number>>('spawn', {
			description: 'Weight of each level (1-10) when camps are spawned at random, e.g. { "1": 20, "10": 2 } (partial).',
			default: () => RULES.spawn as Record<string, number>,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { level: weight }');
				const out = { ...(RULES.spawn as Record<string, number>) };
				for (const [lv, w] of Object.entries(raw)) {
					if (!(lv in out)) throw fail('bad_config', text('Levels are 1-{0}', { 0: LEVELS }));
					out[lv] = numberInRange(0, 1e6)(w);
				}
				return out;
			},
		});
		const starterCamps = ctx.config.define('starterCamps', {
			description:
				'Camps placed on free tiles next to every new capital (at most 8): [{ "kind": "npc-fortress" | "npc-outpost", "level": 1-10 }, ...]; not counted in the seeding, not replaced once uprooted.',
			default: () => csvRows(starterCsv).map((r) => ({ kind: r.kind as Kind, level: csvNumber(r, 'level') })),
			parse: (raw) => {
				if (!Array.isArray(raw) || raw.length > 8) throw fail('bad_config', 'Expected a list of at most 8 { kind, level }');
				return raw.map((c) =>
					shape({ kind: fields.oneOf(KINDS), level: fields.int(1, LEVELS) }, (x) => ({ kind: x.kind as Kind, level: x.level }))(c),
				);
			},
		});
		// The world's camps are placed once, when its map is imported (npc-camps.populate, block by block). After
		// that only camps that go (uprooted) are tracked: each is replaced elsewhere by the background task.
		const respawn = ctx.config.define('respawn', {
			description:
				"Most uprooted NPC camps the background task replaces a minute, on free land elsewhere (a command founds them all at once: on Cloudflare stay under the plan's queries per invocation).",
			default: () => RULES.respawn as number,
			parse: (raw) => Math.floor(numberInRange(0, 1000)(raw)),
		});
		const seedBlocks = ctx.config.define('seedBlocks', {
			description:
				"Blocks the background seeding fills a minute while the world is short of its camps (a new world, or after the GM raised npc-camps.density); about perBlock camps each. On Cloudflare stay under the plan's queries per invocation.",
			default: () => RULES.seedBlocks as number,
			parse: (raw) => Math.floor(numberInRange(0, 256)(raw)),
		});
		const seedingState = async (api: ReadApi) => {
			const { results } = await api.db.prepare('SELECT key, value FROM npc_camps_seeding').all<{ key: string; value: string }>();
			return Object.fromEntries(results.map((r) => [r.key, r.value])) as { done?: string; pass?: string; cursor?: string };
		};
		ctx.tasks.add({
			id: 'npc-camps.upkeep',
			async run({ kernel, env }) {
				const context = await requestContext(kernel, env, 'npc:world', true);
				// Uprooted camps waiting to be replaced (most minutes: none, one small read).
				if (await env.DB.prepare('SELECT 1 FROM npc_camps_respawn LIMIT 1').first())
					await executeCommand(kernel, env.DB, context, 'npc-camps.respawn', null);
				// The world short of its camps for the current density (most minutes: the pass is done, one read).
				const api = { ...context, db: env.DB } as unknown as ReadApi;
				if ((await seedingState(api)).done !== JSON.stringify(context.config['npc-camps.density']))
					await executeCommand(kernel, env.DB, context, 'npc-camps.seedStep', null);
			},
		});
		// One step of a seeding pass: the next blocks, filled up to their counts. A pass is for one density: when
		// the GM changes it, a new pass starts from the first block. pnpm map:import seeds all at once and marks it.
		ctx.commands.add<null>({
			type: 'npc-camps.seedStep',
			privileged: true,
			description: 'Fill the next npc-camps.seedBlocks blocks of the current seeding pass (the background task). Payload: null',
			parse: () => null,
			async execute(api) {
				const step = seedBlocks.get(api);
				if (step <= 0) return;
				const key = densityKey(api);
				const state = await seedingState(api);
				if (state.done === key) return;
				const n = blocksPerSide(api);
				let cursor = state.pass === key ? Number(state.cursor ?? 0) : 0;
				const blocks: [number, number][] = [];
				for (; cursor < n * n && blocks.length < step; cursor++) blocks.push([cursor % n, Math.floor(cursor / n)]);
				await populate(api, blocks);
				const save = (k: string, v: string) =>
					api.write(api.db.prepare('INSERT OR REPLACE INTO npc_camps_seeding (key, value) VALUES (?, ?)').bind(k, v));
				save('pass', key);
				save('cursor', String(cursor));
				if (cursor >= n * n) save('done', key);
			},
		});
		ctx.commands.add<null>({
			type: 'npc-camps.seeded',
			privileged: true,
			description: 'Mark the seeding of the current density done (pnpm map:import, after seeding every block). Payload: null',
			parse: () => null,
			async execute(api) {
				api.write(api.db.prepare("INSERT OR REPLACE INTO npc_camps_seeding (key, value) VALUES ('done', ?)").bind(densityKey(api)));
			},
		});
		ctx.commands.add<null>({
			type: 'npc-camps.respawn',
			privileged: true,
			description: 'Replace uprooted NPC camps on free land, at most npc-camps.respawn a run (the background task). Payload: null',
			parse: () => null,
			async execute(api) {
				const n = respawn.get(api);
				if (n <= 0) return;
				const { results } = await api.db
					.prepare('SELECT id, kind FROM npc_camps_respawn ORDER BY id LIMIT ?')
					.bind(n)
					.all<{ id: number; kind: Kind }>();
				const done: number[] = [];
				for (const r of results) {
					const centre = await map.findFreeSquare(api, 0);
					if (!centre) break; // the map is full: try again next time
					if (KINDS.includes(r.kind)) await spawn(api, r.kind, centre, null);
					done.push(r.id);
				}
				if (done.length)
					api.write(api.db.prepare(`DELETE FROM npc_camps_respawn WHERE id IN (${done.map(() => '?').join(', ')})`).bind(...done));
			},
		});

		// On the map, a camp's tile tells what to expect: its level, roughly how many defend it and how
		// strong its stockade and heroes are, and what a victory brings.
		map.addLayer(async (api, tiles) => {
			const out = new Map<string, Partial<GridCell>>();
			const taken = await map.occupants(api, tiles);
			// Everything in the window at once (not a few queries per camp).
			const ids = [...taken.values()].filter((e) => e.startsWith('settlement:')).map((e) => e.slice('settlement:'.length));
			const found = await settlements.getMany(api, ids);
			await loadLevels(
				api,
				[...found.values()].filter((s) => KINDS.includes(s.kind as Kind)).map((s) => s.id),
			);
			for (const [key, entity] of taken) {
				if (!entity.startsWith('settlement:')) continue;
				const s = found.get(entity.slice('settlement:'.length));
				if (!s || !KINDS.includes(s.kind as Kind)) continue;
				const lv = await levelOf(api, s.id);
				const row = levels.get(api)[s.kind][lv];
				if (!row) continue;
				const perLane = Object.values(row.lane).reduce((a, b) => a + b, 0);
				const share = await refilled(api, s.id, api.now);
				const { raidedAt } = await campRow(api, s.id);
				const best = Math.max(...Object.keys(row.lane).map(Number));
				const info: UiLine[] = [
					{ text: text('Level {0}', { 0: lv }) },
					// "Defenders: about 4,000 in all, up to tier 2, 1 leaders" / "..., leaderless".
					{
						text: row.heroes
							? text('Defenders: about {0} in all, up to tier {1}, {2} leaders', { 0: amount(perLane * 5), 1: best, 2: row.heroes })
							: text('Defenders: about {0} in all, up to tier {1}, leaderless', { 0: amount(perLane * 5), 1: best }),
					},
					{ text: text('Stockade: defence +{0} in every lane', { 0: amount(row.stockade) }), tone: 'muted' },
					s.kind === 'npc-outpost'
						? {
								text: text('Victory: up to {0} resources (as much as your survivors carry)', {
									0: amount(Math.floor((row.loot.total ?? 0) * share)),
								}),
								tone: 'info',
							}
						: {
								text: text('Victory: captures {0}', {
									0: Object.entries(row.loot)
										.filter(([, n]) => n > 0)
										.map(([tier, n]) => text('tier {0} ×{1}', { 0: tier, 1: amount(Math.floor(n * share)) })),
								}),
								tone: 'info',
							},
					...(share < 1 && raidedAt !== null
						? [
								{
									text: text('Recently beaten: full again in {0}', {
										0: duration((raidedAt + refillHours.get(api) * 3600_000 - api.now) / 1000),
									}),
									tone: 'muted' as const,
								},
							]
						: []),
				];
				out.set(key, { info });
			}
			return out;
		});

		const core = { type: 'core', accepts: [] as string[], slots: () => 0 };
		settlements.defineKind({
			id: 'npc-fortress',
			name: 'NPC fortress',
			npc: true,
			garrison: true,
			layout: 'single',
			centre: core,
			extra: { loot: 'troops' },
		});
		settlements.defineKind({
			id: 'npc-outpost',
			name: 'NPC outpost',
			npc: true,
			garrison: false,
			layout: 'single',
			centre: { ...core },
			extra: { loot: 'resources' },
		});

		/** A camp's level (camps from before levels: 1) and when it was last beaten (null: never), read together. */
		const campRow = (api: ReadApi, settlementId: string) =>
			api.memo(`npc-camps:row:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT level, raided_at FROM npc_camps_levels WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ level: number; raided_at: number | null }>();
				return { level: row?.level ?? 1, raidedAt: row?.raided_at ?? null };
			});
		const levelOf = async (api: ReadApi, settlementId: string) => (await campRow(api, settlementId)).level;
		/**
		 * How full a camp's loot / captives are at `at`: emptied by a victory, back to full linearly over
		 * `npc-camps.refillHours` (user 2026-10-06: by time, so one camp cannot be farmed over and over).
		 */
		const refilled = async (api: ReadApi, settlementId: string, at: number) => {
			const { raidedAt } = await campRow(api, settlementId);
			const hours = refillHours.get(api);
			return raidedAt === null || hours <= 0 ? 1 : Math.min(1, Math.max(0, (at - raidedAt) / (hours * 3600_000)));
		};
		/** `levelOf` for many camps at once (one query for all not yet known in this call), e.g. a map window. */
		async function loadLevels(api: ReadApi, ids: string[]) {
			const missing = ids.filter((id) => !api.peek(`npc-camps:row:${id}`));
			for (let i = 0; i < missing.length; i += 90) {
				const chunk = missing.slice(i, i + 90);
				const { results } = await api.db
					.prepare(
						`SELECT settlement_id, level, raided_at FROM npc_camps_levels WHERE settlement_id IN (${chunk.map(() => '?').join(', ')})`,
					)
					.bind(...chunk)
					.all<{ settlement_id: string; level: number; raided_at: number | null }>();
				const byId = new Map(results.map((r) => [r.settlement_id, r]));
				for (const id of chunk)
					void api.memo(`npc-camps:row:${id}`, async () => ({
						level: byId.get(id)?.level ?? 1,
						raidedAt: byId.get(id)?.raided_at ?? null,
					}));
			}
		}
		const levelRow = async (api: ReadApi, camp: { id: string; kind: string }) => levels.get(api)[camp.kind]?.[await levelOf(api, camp.id)];
		/** Unit ids by family and tier, from whatever units are registered. */
		const unitOf = (family: string, tier: number) => troops.list().find((u) => u.family === family && u.tier === tier)?.id;

		ctx.services.get('loot').definePool(POOL);
		const refillHours = ctx.config.define('refillHours', {
			description: 'Hours an NPC camp takes to refill its loot or captives after a victory, linearly (0 = always full).',
			default: () => RULES.refillHours as number,
			parse: numberInRange(0, 24 * 30),
		});
		const lootValue = ctx.config.define('lootValue', {
			description:
				'What a won raid on an NPC settlement brings from its loot pool, at least: base + perLevel x (level - 1) (nothing while the pool is empty).',
			default: () => RULES.lootValue as { base: number; perLevel: number },
			parse: numberFields(() => RULES.lootValue as { base: number; perLevel: number }, 0, 1e6),
		});
		// The stockade, and the defending heroes from level 3.
		battle.addModifier(async (api, side) => {
			if (side.role !== 'defender' || !side.settlement || !KINDS.includes(side.settlement.kind as Kind)) return [];
			const row = await levelRow(api, side.settlement);
			if (!row) return [];
			const out: Awaited<ReturnType<Parameters<typeof battle.addModifier>[0]>> = [];
			if (row.stockade) out.push({ source: text('Stockade'), stat: 'defense', flat: row.stockade });
			if (row.heroes) {
				// Named, and the same names every battle at this camp. Name parts stay keys ("s:Zhao m:Zilong"): clients spell them.
				const names = Array.from({ length: row.heroes }, (_, i) => {
					const n = heroes.randomName(seededRandom(`npc-hero:${side.settlement!.id}:${i}`));
					return heroes.nameKey(n);
				});
				const source = text('Defending heroes: {0}', { 0: names.map(literal) });
				if (row.heroAttack) out.push({ source, stat: 'attack', percent: row.heroAttack });
				if (row.heroDefense) out.push({ source, stat: 'defense', percent: row.heroDefense });
				if (row.heroHp) out.push({ source, stat: 'hp', percent: row.heroHp });
				if (row.heroCasualty) out.push({ source, stat: 'casualty', percent: -row.heroCasualty });
			}
			return out;
		});

		/** The camp on a tile (an occupant "settlement:<id>"), if it is one of ours. */
		const campAt = async (api: ReadApi, occupant: string | null) => {
			if (!occupant?.startsWith('settlement:')) return null;
			const camp = await settlements.get(api, occupant.slice('settlement:'.length));
			return camp && KINDS.includes(camp.kind as Kind) ? camp : null;
		};

		/** A battle at a camp and what a victory brings (attacks and uprooting alike). */
		const raid = async (api: EngineApi, e: Encounter, camp: Settlement): Promise<BattleReport> => {
			// Another army may beat this camp at the same time: what is left to take is read under its lock.
			await api.lock(settlements.entity(camp.id));
			const row = await levelRow(api, camp);
			const share = await refilled(api, camp.id, e.at);
			// A new random formation every battle, fixed by the army id so a retried command agrees;
			// each lane gets the level's garrison in the lane's family.
			const formation = battle.randomFormation(`npc:${e.army.id}`);
			const garrison: Record<string, number> = {};
			for (const family of formation)
				for (const [tier, n] of Object.entries(row?.lane ?? {})) {
					const unit = unitOf(family, Number(tier));
					if (unit && n > 0) garrison[unit] = (garrison[unit] ?? 0) + n;
				}
			const fight = await battle.fight(api, {
				attacker: {
					side: { role: 'attacker', playerId: e.army.playerId, settlement: await settlements.get(api, e.army.from), armyId: e.army.id },
					lanes: battle.attackerLanes(e.army.options, e.army.units),
					units: e.army.units,
				},
				defender: {
					side: { role: 'defender', playerId: null, settlement: camp },
					lanes: battle.defenderLanes(garrison, formation),
					units: garrison,
				},
			});
			const lost = fight.losses.attacker;
			const loot: Record<string, number> = {};
			const captured: Record<string, number> = {};
			if (fight.victory && row) {
				const random = seededRandom(`npc-loot:${e.army.id}`);
				if (camp.kind === 'npc-outpost') {
					// The level's total, leaning towards the resource the tile's terrain favours, within what survivors carry.
					const survivors = Object.fromEntries(Object.entries(e.army.units).map(([u, n]) => [u, n - (lost[u] ?? 0)]));
					const carry = troops.totals(api, survivors).carry;
					const ids = resources.list().map((r) => r.id);
					const bonus = terrain.bonus(api, await terrain.at(api, { x: camp.x, y: camp.y }));
					const best = Math.max(...ids.map((r) => bonus[r] ?? 0));
					const top = ids.filter((r) => (bonus[r] ?? 0) === best);
					const favoured = top[Math.floor(random() * top.length)];
					const total = Math.min(carry, Math.floor((row.loot.total ?? 0) * share));
					for (const r of ids) {
						const n = Math.floor(total * ((1 - row.bias) / ids.length + (r === favoured ? row.bias : 0)));
						if (n > 0) loot[r] = n;
					}
				} else {
					const families = [...new Set(troops.list().flatMap((u) => (u.family ? [u.family] : [])))];
					for (const [tier, full] of Object.entries(row.loot))
						for (let i = 0, n = Math.floor(full * share); i < n; i++) {
							const unit = unitOf(families[Math.floor(random() * families.length)], Number(tier));
							if (unit) captured[unit] = (captured[unit] ?? 0) + 1;
						}
				}
			}
			// A win empties the camp: it refills from now on (a camp from before levels gets its row here).
			if (fight.victory) {
				api.write(
					api.db
						.prepare(
							'INSERT INTO npc_camps_levels (settlement_id, level, raided_at) VALUES (?, ?, ?) ON CONFLICT (settlement_id) DO UPDATE SET raided_at = excluded.raided_at',
						)
						.bind(camp.id, await levelOf(api, camp.id), e.at),
				);
				(await campRow(api, camp.id)).raidedAt = e.at;
			}
			// A win may bring more: the camps' loot pool (empty unless a plugin fills it).
			const drops = ctx.services.get('loot');
			const spoils: RewardLine[] = [];
			if (fight.victory && row && !drops.empty(POOL)) {
				const random = seededRandom(`npc-spoils:${e.army.id}`);
				const level = await levelOf(api, camp.id);
				const v = lootValue.get(api);
				const occasion: NpcCampOccasion = { playerId: e.army.playerId, camp, level };
				const ids = drops.roll(api, POOL, occasion, v.base + v.perLevel * (level - 1), random);
				spoils.push(...(await drops.give(api, POOL, ids, { ...occasion, random })));
			}
			return {
				target: { kind: camp.kind, name: camp.name, ownerName: null },
				...(spoils.length ? { spoils } : {}),
				outcome: fight.victory ? 'victory' : 'defeat',
				attack: fight.attack,
				defense: fight.defense,
				battle: fight.detail,
				promoted: fight.promotions,
				losses: { attacker: lost, defender: {} },
				loot,
				captured,
			};
		};
		armies.addEncounter(async (api, e) => {
			const camp = await campAt(api, e.occupant);
			return camp ? raid(api, e, camp) : null;
		});

		/* ----- uprooting: clearing a camp off the land of a player's outer cities ------------- */

		/** Whether `tile` is where one of the player's settlements could have outer cities. */
		const nearMine = async (api: ReadApi, playerId: string, tile: { x: number; y: number }) =>
			(await settlements.mine(api, playerId)).some((s) => settlements.outerArea(s).some((t) => t.x === tile.x && t.y === tile.y));
		settlements.onRemoved(async (api, s) => {
			if (!KINDS.includes(s.kind as Kind)) return;
			const row = await api.db
				.prepare('SELECT starter FROM npc_camps_levels WHERE settlement_id = ?')
				.bind(s.id)
				.first<{ starter: number }>();
			api.write(api.db.prepare('DELETE FROM npc_camps_levels WHERE settlement_id = ?').bind(s.id));
			// Replaced elsewhere by the background task (npc-camps.respawn); a capital's starter camps are not.
			if (!row?.starter) api.write(api.db.prepare('INSERT INTO npc_camps_respawn (kind, removed_at) VALUES (?, ?)').bind(s.kind, api.now));
		});
		armies.defineMission({
			id: 'uproot',
			name: 'mission:uproot',
			battle: true,
			async check(api, { from, tile, occupant }) {
				if (!(await campAt(api, occupant))) return text('Only NPC fortresses and outposts can be uprooted');
				if (!from.ownerId || !(await nearMine(api, from.ownerId, tile)))
					return text('Only camps on the land of your outer cities can be uprooted');
				return null;
			},
			async arrive(api, arrival) {
				// The camp is shared by everyone: lock it before reading, so two armies cannot both clear it.
				if (arrival.occupant) await api.lock(arrival.occupant);
				const camp = await campAt(api, arrival.occupant);
				if (!camp)
					return {
						report: {
							target: { kind: 'empty' },
							outcome: 'no-battle',
							note: text('The camp is gone'),
							attack: 0,
							defense: 0,
							losses: { attacker: {}, defender: {} },
							loot: {},
							captured: {},
						},
					};
				const report = await raid(api, arrival, camp);
				// All five lanes won: the camp is cleared away and its tile is free for an outer city.
				if (report.battle?.lanes.every((l) => l.winner === 'attacker')) {
					await settlements.remove(api, camp.id);
					report.note = text('Uprooted: the land is free');
				}
				return { report };
			},
		});
		ctx.commands.add<SendOrder>({
			type: 'npc-camps.uproot',
			description:
				'Uproot an NPC camp on the land of your outer cities (all five lanes won clears it). Payload as armies.send, without "mission".',
			form: {
				title: text('Uproot'),
				description: text(
					'Win all five lanes and the camp is cleared away, freeing the land for an outer city. Otherwise it is an ordinary raid.',
				),
				placement: 'tile',
				fields: [
					{ name: 'from', label: text('From'), type: 'select', required: true },
					{ name: 'x', label: text('x'), type: 'hidden' },
					{ name: 'y', label: text('y'), type: 'hidden' },
				],
				submitLabel: text('March'),
				async prepare(api, params) {
					if (params.x === undefined || params.y === undefined) return false;
					const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
					const occupant = (await map.occupants(api, [tile])).get(`${tile.x},${tile.y}`) ?? null;
					if (!(await campAt(api, occupant)) || !(await nearMine(api, api.playerId, tile))) return false;
					return armies.sendForm(api, params, 'uproot');
				},
			},
			parse: (raw) => armies.parseOrder(raw, 'uproot'),
			execute: async (api, order) => void (await armies.dispatch(api, order)),
		});

		/* ----- spawning ------------------------------------------------------------------- */

		const kindField = {
			name: 'kind',
			label: text('Kind'),
			type: 'select' as const,
			required: true,
			options: KINDS.map((k) => ({ value: k, label: text(k === 'npc-fortress' ? 'NPC fortress' : 'NPC outpost') })),
		};
		/** Found a camp of `level` (null = at random by the spawn weights) and remember its level (`starter`: by a new capital). */
		async function spawn(
			api: Parameters<typeof settlements.found>[0],
			kind: Kind,
			centre: { x: number; y: number },
			level: number | null,
			starter = false,
		) {
			let lv = level;
			if (!lv) {
				const w = spawnWeights.get(api);
				const total = Object.values(w).reduce((a, b) => a + b, 0);
				let at = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * total;
				lv = 1;
				for (let l = 1; l <= LEVELS; l++)
					if ((at -= w[l] ?? 0) < 0) {
						lv = l;
						break;
					}
			}
			// Stored as an i18n key (shown translated); the level's name comes from npc-camps' own table.
			const raw = levels.get(api)[kind][lv]?.name;
			const name = raw ? `npc-camps.${raw}` : settlements.kind(kind).name;
			const id = await settlements.found(api, { kind, ownerId: null, name, centre });
			api.write(
				api.db.prepare('INSERT INTO npc_camps_levels (settlement_id, level, starter) VALUES (?, ?, ?)').bind(id, lv, starter ? 1 : 0),
			);
		}

		// A new capital's first targets, next to it (outer cities go there: uprooting them clears the land).
		settlements.onFounded(async (api, s) => {
			if (s.kind !== 'capital' || !s.ownerId) return;
			const camps = starterCamps.get(api);
			if (!camps.length) return;
			const around: { x: number; y: number }[] = [];
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) if (dx || dy) around.push({ x: map.wrap(s.x + dx), y: map.wrap(s.y + dy) });
			// Its own districts (e.g. its first outer city) are claimed in this same call: not in the map table yet.
			const own = new Set(s.districts.map((d) => `${d.x},${d.y}`));
			const taken = await map.occupants(api, around);
			const free = around.filter((t) => !taken.has(`${t.x},${t.y}`) && !own.has(`${t.x},${t.y}`));
			const random = seededRandom(`npc-camps:starter:${s.id}`);
			for (const c of camps) {
				if (!free.length) break;
				await spawn(api, c.kind, free.splice(Math.floor(random() * free.length), 1)[0], c.level, true);
			}
		});

		ctx.commands.add<{ kind: Kind; x: number; y: number; level: number | null }>({
			type: 'npc-camps.spawnAt',
			form: {
				title: text('Place an NPC camp'),
				placement: 'gm',
				fields: [
					kindField,
					{ name: 'level', label: text('Level (1-10)'), type: 'number', min: 1, max: LEVELS, default: 1 },
					{ name: 'x', label: text('x'), type: 'number', required: true, min: -511, max: 512 },
					{ name: 'y', label: text('y'), type: 'number', required: true, min: -511, max: 512 },
				],
				submitLabel: text('Place'),
			},
			privileged: true,
			description: 'Place one NPC settlement on a chosen free tile. Payload: { "kind", "x", "y", "level"?: 1-10 (default 1) }',
			parse: shape(
				{ kind: fields.oneOf(KINDS), x: fields.int(-1e4, 1e4), y: fields.int(-1e4, 1e4), level: fields.orElse(fields.int(0, LEVELS), 0) },
				(p) => ({ kind: p.kind, x: map.wrap(p.x), y: map.wrap(p.y), level: p.level || 1 }),
			),
			async execute(api, { kind, x, y, level }) {
				await spawn(api, kind, { x, y }, level);
			},
		});

		const density = ctx.config.define('density', {
			description:
				'Seeding a new world (npc-camps.populate): blockSize tiles a side, perBlock camps per block give or take spread, fortressShare of them fortresses.',
			default: () => RULES.density as Record<string, number>,
			parse: numberFields(() => RULES.density as Record<string, number>, 0, 1024),
		});

		/** How many camps a block should have: perBlock give or take spread, fixed by the block (its seed). */
		const blockTarget = (api: ReadApi, bx: number, by: number) => {
			const d = density.get(api);
			const random = seededRandom(`npc-camps:populate:${bx},${by}`);
			const spread = Math.round(d.spread);
			const count = Math.max(0, Math.round(d.perBlock) + Math.floor(random() * (2 * spread + 1)) - spread);
			return { count, random };
		};
		const blocksPerSide = (api: ReadApi) => Math.ceil(map.size / Math.max(1, Math.floor(density.get(api).blockSize)));

		/** Fill these blocks up to their counts (see npc-camps.populate). */
		async function populate(api: EngineApi, blocks: [number, number][]) {
			const d = density.get(api);
			const size = Math.max(1, Math.floor(d.blockSize));
			for (const [bx, by] of blocks) {
				// Seeded by the block: a retried command places the same camps.
				const { count, random } = blockTarget(api, bx, by);
				const tiles: { x: number; y: number }[] = [];
				for (let dy = 0; dy < size; dy++)
					for (let dx = 0; dx < size; dx++) tiles.push({ x: map.wrap(bx * size + dx), y: map.wrap(by * size + dy) });
				// One query for the block: the window around its middle, then only its own tiles.
				const half = Math.ceil(size / 2);
				const inBlock = new Set(tiles.map((t) => `${t.x},${t.y}`));
				const taken = new Map(
					(await map.window(api, { x: map.wrap(bx * size + half), y: map.wrap(by * size + half) }, half))
						.filter((t) => inBlock.has(`${t.x},${t.y}`))
						.map((t) => [`${t.x},${t.y}`, t.entity]),
				);
				// The camps already there (one query for the block: npc-camps' own table).
				const ids = [...new Set(taken.values())].filter((e) => e.startsWith('settlement:')).map((e) => e.slice('settlement:'.length));
				let have = 0;
				for (let i = 0; i < ids.length; i += 90) {
					const chunk = ids.slice(i, i + 90);
					const row = await api.db
						.prepare(
							`SELECT COUNT(*) AS n FROM npc_camps_levels WHERE starter = 0 AND settlement_id IN (${chunk.map(() => '?').join(', ')})`,
						)
						.bind(...chunk)
						.first<{ n: number }>();
					have += row?.n ?? 0;
				}
				const free = tiles.filter((t) => !taken.has(`${t.x},${t.y}`));
				for (let i = have; i < count && free.length; i++) {
					const tile = free.splice(Math.floor(random() * free.length), 1)[0];
					await spawn(api, random() < d.fortressShare ? 'npc-fortress' : 'npc-outpost', tile, null);
				}
			}
		}
		/** The density rule as a key: a seeding pass is for one set of numbers; new numbers, a new pass. */
		const densityKey = (api: ReadApi) => JSON.stringify(density.get(api));

		// The world's camps, block by block, so every corner has some (pnpm map:import runs it after the terrain;
		// scripts/dev.mjs runs it again at start-up while the world is short). Each block is filled up to its own
		// count: running it again adds only what is missing.
		ctx.commands.add<{ blocks: [number, number][] }>({
			type: 'npc-camps.populate',
			privileged: true,
			description:
				'Fill NPC camps block by block up to each block\'s count (rule npc-camps.density: about perBlock camps in each blockSize x blockSize block, on free tiles). Payload: { "blocks": [[bx, by], ...] } (block bx covers x = bx * blockSize ... wrapped; at most 32 blocks).',
			parse: shape({ blocks: fields.list(fields.list(fields.int(0, 1023), { min: 2, max: 2 }), { min: 1, max: 32 }) }, (p) => ({
				blocks: p.blocks.map(([bx, by]) => [bx, by] as [number, number]),
			})),
			execute: (api, { blocks }) => populate(api, blocks),
		});

		// For the start-up check (scripts/dev.mjs through pnpm map:import): how many camps there are, how many the
		// blocks should hold. Counting reads every camp: once per start, not per request.
		ctx.reports.add({
			id: 'npc-camps.seeding',
			description: "NPC camps on the map and how many the seeding aims for (the sum of every block's count).",
			example: {},
			async run(api) {
				const row = await api.db.prepare('SELECT COUNT(*) AS n FROM npc_camps_levels WHERE starter = 0').first<{ n: number }>();
				const n = blocksPerSide(api);
				let target = 0;
				for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) target += blockTarget(api, bx, by).count;
				return [{ camps: row?.n ?? 0, target, blocksPerSide: n }];
			},
		});

		ctx.commands.add<{ kind: Kind; count: number; level: number | null }>({
			type: 'npc-camps.spawn',
			form: {
				title: text('Spawn NPC camps at random'),
				placement: 'gm',
				fields: [
					kindField,
					{ name: 'count', label: text('Count'), type: 'number', required: true, min: 1, max: 20, default: 5 },
					{ name: 'level', label: text('Level (1-10, empty = by spawn weights)'), type: 'number', min: 0, max: LEVELS },
				],
				submitLabel: text('Spawn'),
			},
			privileged: true,
			description:
				'Place NPC settlements on random free tiles. Payload: { "kind": "npc-outpost" | "npc-fortress", "count": 5, "level"?: 1-10 }',
			// Level 0 / empty: by the spawn weights.
			parse: shape(
				{ kind: fields.oneOf(KINDS), count: fields.orElse(fields.int(1, 20), 1), level: fields.orElse(fields.int(0, LEVELS), 0) },
				(p) => ({ kind: p.kind, count: p.count, level: p.level || null }),
			),
			async execute(api, { kind, count, level }) {
				for (let i = 0; i < count; i++) {
					const centre = await map.findFreeSquare(api, 0);
					if (!centre) throw fail('map_full', 'Could not find free land', 503);
					await spawn(api, kind, centre, level);
				}
			},
		});
	},
});
