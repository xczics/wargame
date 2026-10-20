/**
 * NPC settlements to raid (docs/design/gameplay.md §3.12), each of a level 1-10:
 *
 *   npc-fortress  beating it captures some troops
 *   npc-outpost   beating it carries off resources, leaning towards what its tile is good for
 *
 * Everything a level means is data (./data/levels.csv, GM rule `npc-camps.levels`): its name, the
 * stockade (flat defence in every lane), the garrison of each lane by tier (families from a random
 * formation every battle; NPCs never lose troops), the loot, and from level 3 defending heroes
 * (battle bonuses).
 *
 * Where they stand (1.4): the world's camps are worked out by a rule (./layout.ts: seed, density, level weights), not
 * stored; they reach the rest of the game as virtual occupants of the map (`worldMap.addVirtual`) and virtual
 * settlements (`settlements.addVirtual`, ids "npc:<bx>,<by>,<slot>"). Only what happened to one is stored
 * (`npc_camps_state`: when it was last beaten, whether it is gone). A rule camp never stands within a capital's
 * 3 x 3, nor on a stored occupant's tile. Camps that are stored as before: a new capital's starter camps, the ones the
 * GM places, and those that replace uprooted camps (the background task, on free land elsewhere).
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
import { isRuleCamp, layoutOf, type RuleCamp } from './layout';
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
				'Camps placed on free tiles next to every new capital (at most 8): [{ "kind": "npc-fortress" | "npc-outpost", "level": 1-10 }, ...]; not counted with the rule camps, not replaced once uprooted.',
			default: () => csvRows(starterCsv).map((r) => ({ kind: r.kind as Kind, level: csvNumber(r, 'level') })),
			parse: (raw) => {
				if (!Array.isArray(raw) || raw.length > 8) throw fail('bad_config', 'Expected a list of at most 8 { kind, level }');
				return raw.map((c) =>
					shape({ kind: fields.oneOf(KINDS), level: fields.int(1, LEVELS) }, (x) => ({ kind: x.kind as Kind, level: x.level }))(c),
				);
			},
		});
		// Camps that go (uprooted) are replaced elsewhere by the background task, as stored camps.
		const respawn = ctx.config.define('respawn', {
			description:
				"Most uprooted NPC camps the background task replaces a minute, on free land elsewhere (a command founds them all at once: on Cloudflare stay under the plan's queries per invocation).",
			default: () => RULES.respawn as number,
			parse: (raw) => Math.floor(numberInRange(0, 1000)(raw)),
		});
		ctx.tasks.add({
			id: 'npc-camps.upkeep',
			async run({ kernel, env }) {
				// Uprooted camps waiting to be replaced (most runs: none, one small read and nothing worked out).
				if (!(await env.DB.prepare('SELECT 1 FROM npc_camps_respawn LIMIT 1').first())) return;
				await executeCommand(kernel, env.DB, await requestContext(kernel, env, 'npc:world', true), 'npc-camps.respawn', null);
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
				if (isRuleCamp(settlementId))
					return { level: layout(api).byId(settlementId)?.level ?? 1, raidedAt: (await stateOf(api, settlementId)).raidedAt };
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
			await loadStates(
				api,
				ids.filter((id) => isRuleCamp(id)),
			);
			const missing = ids.filter((id) => !isRuleCamp(id) && !api.peek(`npc-camps:row:${id}`));
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
		// Where raids on camps happen, for aiming drops at a place: kind > level.
		ctx.services.get('loot').describeSites<NpcCampOccasion>(POOL, {
			label: text('NPC camps'),
			tree: async () =>
				KINDS.map((k) => ({
					id: k,
					label: text(k === 'npc-fortress' ? 'NPC fortress' : 'NPC outpost'),
					children: Array.from({ length: LEVELS }, (_, i) => ({ id: String(i + 1), label: text('Level {0}', { 0: i + 1 }) })),
				})),
			path: (c) => [c.camp.kind, String(c.level)],
		});
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
				if (isRuleCamp(camp.id)) {
					// A rule camp's first row: the only thing stored about it.
					api.write(
						api.db
							.prepare(
								'INSERT INTO npc_camps_state (id, raided_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET raided_at = excluded.raided_at',
							)
							.bind(camp.id, e.at),
					);
					(await stateOf(api, camp.id)).raidedAt = e.at;
				} else
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
				const ids = await drops.roll(api, POOL, occasion, v.base + v.perLevel * (level - 1), random);
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
			const replace = !(await clearing(api)).on;
			if (isRuleCamp(s.id)) {
				// Gone for good under these rules; replaced elsewhere like any uprooted camp.
				api.write(
					api.db.prepare('INSERT INTO npc_camps_state (id, removed) VALUES (?, 1) ON CONFLICT (id) DO UPDATE SET removed = 1').bind(s.id),
				);
				(await stateOf(api, s.id)).removed = true;
				if (replace) api.write(api.db.prepare('INSERT INTO npc_camps_respawn (kind, removed_at) VALUES (?, ?)').bind(s.kind, api.now));
				return;
			}
			const row = await api.db
				.prepare('SELECT starter FROM npc_camps_levels WHERE settlement_id = ?')
				.bind(s.id)
				.first<{ starter: number }>();
			api.write(api.db.prepare('DELETE FROM npc_camps_levels WHERE settlement_id = ?').bind(s.id));
			// Replaced elsewhere by the background task (npc-camps.respawn); a capital's starter camps are not.
			if (!row?.starter && replace)
				api.write(api.db.prepare('INSERT INTO npc_camps_respawn (kind, removed_at) VALUES (?, ?)').bind(s.kind, api.now));
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
				// A rule camp there gives way (recorded as gone, not replaced elsewhere: the GM's camp takes its place).
				const occupant = (await map.occupants(api, [{ x, y }])).get(`${x},${y}`);
				if (occupant?.startsWith('settlement:npc:')) {
					await api.lock(occupant);
					(await clearing(api)).on = true;
					await settlements.remove(api, occupant.slice('settlement:'.length));
					(await clearing(api)).on = false;
				}
				await spawn(api, kind, { x, y }, level);
			},
		});

		const density = ctx.config.define('density', {
			description:
				"Where the world's NPC camps stand, worked out (not stored): the map in blocks of blockSize tiles a side, perBlock camps per block give or take spread, fortressShare of them fortresses, levels by npc-camps.spawn; seed: another number, another layout. Changes apply at once to the camps nobody touched.",
			default: () => RULES.density as Record<string, number>,
			parse: numberFields(() => RULES.density as Record<string, number>, 0, 1e9),
		});
		const layout = (api: ReadApi) => {
			const d = density.get(api);
			return layoutOf(
				{
					seed: d.seed,
					blockSize: d.blockSize,
					perBlock: d.perBlock,
					spread: d.spread,
					fortressShare: d.fortressShare,
					weights: spawnWeights.get(api),
				},
				map.size,
				map.wrap,
			);
		};

		/* ----- rule camps: what happened to them, and whether they stand ------------------- */

		/** What is stored about a rule camp: when it was last beaten (null: never), whether it is gone. */
		const stateOf = (api: ReadApi, id: string) =>
			api.memo(`npc-camps:state:${id}`, async () => {
				const row = await api.db
					.prepare('SELECT raided_at, removed FROM npc_camps_state WHERE id = ?')
					.bind(id)
					.first<{ raided_at: number | null; removed: number }>();
				return { raidedAt: row?.raided_at ?? null, removed: !!row?.removed };
			});
		/** `stateOf` for many at once (one query for all not yet known in this call). */
		async function loadStates(api: ReadApi, ids: string[]) {
			const missing = [...new Set(ids)].filter((id) => !api.peek(`npc-camps:state:${id}`));
			for (let i = 0; i < missing.length; i += 90) {
				const chunk = missing.slice(i, i + 90);
				const { results } = await api.db
					.prepare(`SELECT id, raided_at, removed FROM npc_camps_state WHERE id IN (${chunk.map(() => '?').join(', ')})`)
					.bind(...chunk)
					.all<{ id: string; raided_at: number | null; removed: number }>();
				const byId = new Map(results.map((r) => [r.id, r]));
				for (const id of chunk)
					void api.memo(`npc-camps:state:${id}`, async () => ({
						raidedAt: byId.get(id)?.raided_at ?? null,
						removed: !!byId.get(id)?.removed,
					}));
			}
		}
		/** Removals in this call that must not be replaced elsewhere (the GM clearing land or placing a camp). */
		const clearing = (api: ReadApi) => api.memo('npc-camps:clearing', async () => ({ on: false }));
		/**
		 * The rule camps of these that stand: not gone, no stored occupant on the tile, and not within a capital's 3 x 3
		 * (user 2026-10-18: a new player never finds a camp they cannot beat next to the capital; cities get no such
		 * shelter). One query for their states, one for the stored tiles around them, one for those settlements.
		 */
		async function standing(api: ReadApi, camps: RuleCamp[]): Promise<RuleCamp[]> {
			if (!camps.length) return [];
			await loadStates(
				api,
				camps.map((c) => c.id),
			);
			const around = new Map<string, { x: number; y: number }>();
			for (const c of camps)
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const t = { x: map.wrap(c.x + dx), y: map.wrap(c.y + dy) };
						around.set(`${t.x},${t.y}`, t);
					}
			const stored = await map.stored(api, [...around.values()]);
			const ids = [...new Set([...stored.values()].filter((e) => e.startsWith('settlement:')).map((e) => e.slice('settlement:'.length)))];
			const near = ids.length ? await settlements.getMany(api, ids) : new Map<string, Settlement>();
			const capitals = [...near.values()].filter((s) => s.kind === 'capital');
			const out: RuleCamp[] = [];
			for (const c of camps) {
				if ((await stateOf(api, c.id)).removed || stored.has(`${c.x},${c.y}`)) continue;
				if (capitals.some((cap) => map.ring(cap, c) <= 1)) continue;
				out.push(c);
			}
			return out;
		}
		const asSettlement = (api: ReadApi, c: RuleCamp): Settlement => {
			// Named by an i18n key (shown translated), like stored camps: the level's name from our own table.
			const raw = levels.get(api)[c.kind][c.level]?.name;
			return {
				id: c.id,
				kind: c.kind,
				ownerId: null,
				name: raw ? `npc-camps.${raw}` : settlements.kind(c.kind).name,
				x: c.x,
				y: c.y,
				createdAt: 0,
				districts: [{ id: `${c.id}/core`, settlementId: c.id, type: 'core', idx: 0, slots: 0, extra: 0, x: c.x, y: c.y }],
			};
		};
		map.addVirtual({
			async at(api, tiles) {
				const l = layout(api);
				const camps = tiles.flatMap((t) => l.at(t.x, t.y) ?? []);
				return new Map((await standing(api, camps)).map((c) => [`${c.x},${c.y}`, `settlement:${c.id}`]));
			},
			async area(api, centre, radius) {
				return (await standing(api, layout(api).around(centre, radius))).map((c) => ({ x: c.x, y: c.y, entity: `settlement:${c.id}` }));
			},
		});
		settlements.addVirtual({
			owns: isRuleCamp,
			async get(api, ids) {
				const l = layout(api);
				const camps = ids.flatMap((id) => l.byId(id) ?? []);
				return new Map((await standing(api, camps)).map((c) => [c.id, asSettlement(api, c)]));
			},
		});

		// How many camps there are: the rule's (all of them worked out once), those gone, and the stored ones.
		ctx.reports.add({
			id: 'npc-camps.count',
			description:
				'NPC camps on the map: placed by the rule (npc-camps.density), of those gone (uprooted), stored ones (placed by the GM or replacing uprooted camps) and starter camps.',
			example: {},
			async run(api) {
				const l = layout(api);
				let rule = 0;
				for (let by = 0; by < l.blocks; by++) for (let bx = 0; bx < l.blocks; bx++) rule += l.block(bx, by).camps.length;
				const gone = await api.db.prepare('SELECT COUNT(*) AS n FROM npc_camps_state WHERE removed = 1').first<{ n: number }>();
				const stored = await api.db
					.prepare('SELECT SUM(starter = 0) AS placed, SUM(starter = 1) AS starter FROM npc_camps_levels')
					.first<{ placed: number | null; starter: number | null }>();
				return [{ rule, gone: gone?.n ?? 0, placed: stored?.placed ?? 0, starter: stored?.starter ?? 0 }];
			},
		});

		// Worlds from before 1.4 hold their seeded camps as stored rows: the GM clears them away a batch at a time,
		// leaving the land to the rule (starter camps and camps beaten since are kept).
		ctx.commands.add<{ count: number }>({
			type: 'npc-camps.clearStored',
			privileged: true,
			description:
				'Remove stored NPC camps that are not starter camps and were never beaten (worlds seeded before 1.4), at most count a call; the rule places camps instead. Payload: { "count": 1-20 }',
			form: {
				title: text('Clear old seeded camps'),
				placement: 'gm',
				fields: [{ name: 'count', label: text('Count'), type: 'number', required: true, min: 1, max: 20, default: 20 }],
				submitLabel: text('Clear'),
			},
			parse: shape({ count: fields.orElse(fields.int(1, 20), 20) }),
			async execute(api, { count }) {
				const { results } = await api.db
					.prepare('SELECT settlement_id FROM npc_camps_levels WHERE starter = 0 AND raided_at IS NULL LIMIT ?')
					.bind(count)
					.all<{ settlement_id: string }>();
				(await clearing(api)).on = true;
				for (const r of results) {
					await api.lock(settlements.entity(r.settlement_id));
					await settlements.remove(api, r.settlement_id);
				}
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
