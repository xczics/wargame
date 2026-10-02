/**
 * NPC settlements to raid (docs/design/gameplay.md §3.12), each of a level 1-10:
 *
 *   npc-fortress  beating it captures some troops
 *   npc-outpost   beating it carries off resources, leaning towards what its tile is good for
 *
 * Everything a level means is data (./data/levels.csv, GM rule `npc-camps.levels`): its name, the
 * stockade (flat defence in every lane), the garrison of each lane by tier (families from a random
 * formation every battle; NPCs never lose troops), the loot, and from level 3 defending heroes
 * (battle bonuses). Camps are spawned by the GM or by a background task keeping a population.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	executeCommand,
	GameError,
	numberInRange,
	seededRandom,
	type ReadApi,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
	if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', `${where}: expected { tier: count }`);
	return Object.fromEntries(
		Object.entries(raw).map(([t, n]) => {
			if (!/^[1-9]\d*$/.test(t) && t !== 'total') throw new GameError('bad_config', `${where}: "${t}" is not a tier`);
			return [t, Math.floor(numberInRange(0, 1e9)(n))];
		}),
	);
};

export default definePlugin({
	id: 'npc-camps',
	version: '0.2.0',
	description: 'NPC fortresses (raid for troops) and outposts (raid for resources), levels 1-10',
	dependsOn: ['settlements', 'world-map', 'armies', 'resources', 'troops', 'battle', 'terrain', 'heroes', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
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
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { kind: { level: {...} } }');
				const out = structuredClone(FILE);
				for (const [kind, byLevel] of Object.entries(raw as Record<string, Record<string, Record<string, unknown>>>)) {
					if (!KINDS.includes(kind as Kind)) throw new GameError('bad_config', `Unknown NPC kind "${kind}"`);
					for (const [lv, patch] of Object.entries(byLevel ?? {})) {
						const level = Number(lv);
						const where = `${kind}.${lv}`;
						if (!out[kind][level]) throw new GameError('bad_config', `${where}: levels are 1-${LEVELS}`);
						const row = out[kind][level];
						for (const [k, v] of Object.entries(patch ?? {})) {
							if (k === 'name') {
								if (typeof v !== 'string' || !v) throw new GameError('bad_config', `${where}.name must be text`);
								row.name = v;
							} else if (k === 'lane' || k === 'loot') row[k] = tierMap(v, `${where}.${k}`);
							else if (k === 'bias') row.bias = numberInRange(0, 1)(v);
							else if (k in row) (row as unknown as Record<string, number>)[k] = numberInRange(0, 1e12)(v);
							else throw new GameError('bad_config', `${where}: unknown field "${k}"`);
						}
					}
				}
				return out;
			},
		});
		const population = ctx.config.define<Record<string, number>>('population', {
			description:
				'How many NPC camps of each kind the world keeps; a background task tops up missing ones (at most 5 per minute). 0 = off.',
			default: () => RULES.population as Record<string, number>,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { kind: count }');
				return Object.fromEntries(
					Object.entries(raw).map(([k, n]) => {
						if (!KINDS.includes(k as Kind)) throw new GameError('bad_config', `Unknown NPC kind "${k}"`);
						return [k, Math.floor(numberInRange(0, 100_000)(n))];
					}),
				);
			},
		});
		const spawnWeights = ctx.config.define<Record<string, number>>('spawn', {
			description: 'Weight of each level (1-10) when camps are spawned at random, e.g. { "1": 20, "10": 2 } (partial).',
			default: () => RULES.spawn as Record<string, number>,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { level: weight }');
				const out = { ...(RULES.spawn as Record<string, number>) };
				for (const [lv, w] of Object.entries(raw)) {
					if (!(lv in out)) throw new GameError('bad_config', `Levels are 1-${LEVELS}`);
					out[lv] = numberInRange(0, 1e6)(w);
				}
				return out;
			},
		});
		ctx.tasks.add({
			id: 'npc-camps.upkeep',
			async run({ kernel, env }) {
				const context = await requestContext(kernel, env, 'npc:world', true);
				let budget = 5;
				for (const [kind, wanted] of Object.entries(population.get(context))) {
					const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM settlements_settlements WHERE kind = ?')
						.bind(kind)
						.first<{ n: number }>();
					const missing = Math.min(budget, wanted - (row?.n ?? 0));
					if (missing <= 0) continue;
					await executeCommand(kernel, env.DB, context, 'npc-camps.spawn', { kind, count: missing });
					budget -= missing;
				}
			},
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

		/** A camp's level (camps from before levels: 1). */
		const levelOf = (api: ReadApi, settlementId: string) =>
			api.memo(`npc-camps:level:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT level FROM npc_camps_levels WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ level: number }>();
				return row?.level ?? 1;
			});
		const levelRow = async (api: ReadApi, camp: { id: string; kind: string }) => levels.get(api)[camp.kind]?.[await levelOf(api, camp.id)];
		/** Unit ids by family and tier, from whatever units are registered. */
		const unitOf = (family: string, tier: number) => troops.list().find((u) => u.family === family && u.tier === tier)?.id;

		// The stockade, and the defending heroes from level 3.
		battle.addModifier(async (api, side) => {
			if (side.role !== 'defender' || !side.settlement || !KINDS.includes(side.settlement.kind as Kind)) return [];
			const row = await levelRow(api, side.settlement);
			if (!row) return [];
			const out: Awaited<ReturnType<Parameters<typeof battle.addModifier>[0]>> = [];
			if (row.stockade) out.push({ source: 'Stockade', stat: 'defense', flat: row.stockade });
			if (row.heroes) {
				// Named, and the same names every battle at this camp. Name parts stay keys ("s:Zhao m:Zilong"): clients spell them.
				const names = Array.from({ length: row.heroes }, (_, i) => {
					const n = heroes.randomName(seededRandom(`npc-hero:${side.settlement!.id}:${i}`));
					return `${n.surname} ${n.given}`;
				});
				const source = `Defending heroes: ${names.join(', ')}`;
				if (row.heroAttack) out.push({ source, stat: 'attack', percent: row.heroAttack });
				if (row.heroDefense) out.push({ source, stat: 'defense', percent: row.heroDefense });
				if (row.heroHp) out.push({ source, stat: 'hp', percent: row.heroHp });
				if (row.heroCasualty) out.push({ source, stat: 'casualty', percent: -row.heroCasualty });
			}
			return out;
		});

		armies.addEncounter(async (api, e) => {
			if (!e.occupant?.startsWith('settlement:')) return null;
			const camp = await settlements.get(api, e.occupant.slice('settlement:'.length));
			if (!camp || !KINDS.includes(camp.kind as Kind)) return null;
			const row = await levelRow(api, camp);
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
					const total = Math.min(carry, row.loot.total ?? 0);
					for (const r of ids) {
						const n = Math.floor(total * ((1 - row.bias) / ids.length + (r === favoured ? row.bias : 0)));
						if (n > 0) loot[r] = n;
					}
				} else {
					const families = [...new Set(troops.list().flatMap((u) => (u.family ? [u.family] : [])))];
					for (const [tier, n] of Object.entries(row.loot))
						for (let i = 0; i < n; i++) {
							const unit = unitOf(families[Math.floor(random() * families.length)], Number(tier));
							if (unit) captured[unit] = (captured[unit] ?? 0) + 1;
						}
				}
			}
			return {
				target: { kind: camp.kind, name: camp.name, ownerName: null },
				outcome: fight.victory ? 'victory' : 'defeat',
				attack: fight.attack,
				defense: fight.defense,
				battle: fight.detail,
				promoted: fight.promotions,
				losses: { attacker: lost, defender: {} },
				loot,
				captured,
			};
		});

		/* ----- spawning ------------------------------------------------------------------- */

		const kindField = {
			name: 'kind',
			label: 'Kind',
			type: 'select' as const,
			required: true,
			options: KINDS.map((k) => ({ value: k, label: k === 'npc-fortress' ? 'NPC fortress' : 'NPC outpost' })),
		};
		const parseKind = (p: Record<string, unknown>) => {
			if (!KINDS.includes(p.kind as Kind)) throw new GameError('bad_payload', `kind must be one of: ${KINDS.join(', ')}`);
			return p.kind as Kind;
		};
		const parseLevel = (v: unknown) =>
			v === undefined || v === '' || v === 0 || v === '0' ? null : Math.floor(numberInRange(1, LEVELS)(v));
		/** Found a camp of `level` (null = at random by the spawn weights) and remember its level. */
		async function spawn(api: Parameters<typeof settlements.found>[0], kind: Kind, centre: { x: number; y: number }, level: number | null) {
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
			const name = levels.get(api)[kind][lv]?.name ?? settlements.kind(kind).name;
			const id = await settlements.found(api, { kind, ownerId: null, name, centre });
			api.write(api.db.prepare('INSERT INTO npc_camps_levels (settlement_id, level) VALUES (?, ?)').bind(id, lv));
		}

		ctx.commands.add<{ kind: Kind; x: number; y: number; level: number | null }>({
			type: 'npc-camps.spawnAt',
			form: {
				title: 'Place an NPC camp',
				placement: 'gm',
				fields: [
					kindField,
					{ name: 'level', label: 'Level (1-10)', type: 'number', min: 1, max: LEVELS, default: 1 },
					{ name: 'x', label: 'x', type: 'number', required: true, min: -511, max: 512 },
					{ name: 'y', label: 'y', type: 'number', required: true, min: -511, max: 512 },
				],
				submitLabel: 'Place',
			},
			privileged: true,
			description: 'Place one NPC settlement on a chosen free tile. Payload: { "kind", "x", "y", "level"?: 1-10 (default 1) }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				const kind = parseKind(p);
				const x = Number(p.x);
				const y = Number(p.y);
				if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'x and y must be integers');
				return { kind, x: map.wrap(x), y: map.wrap(y), level: parseLevel(p.level) ?? 1 };
			},
			async execute(api, { kind, x, y, level }) {
				await spawn(api, kind, { x, y }, level);
			},
		});

		ctx.commands.add<{ kind: Kind; count: number; level: number | null }>({
			type: 'npc-camps.spawn',
			form: {
				title: 'Spawn NPC camps at random',
				placement: 'gm',
				fields: [
					kindField,
					{ name: 'count', label: 'Count', type: 'number', required: true, min: 1, max: 20, default: 5 },
					{ name: 'level', label: 'Level (1-10, empty = by spawn weights)', type: 'number', min: 0, max: LEVELS },
				],
				submitLabel: 'Spawn',
			},
			privileged: true,
			description:
				'Place NPC settlements on random free tiles. Payload: { "kind": "npc-outpost" | "npc-fortress", "count": 5, "level"?: 1-10 }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				return { kind: parseKind(p), count: Math.floor(numberInRange(1, 20)(p.count ?? 1)), level: parseLevel(p.level) };
			},
			async execute(api, { kind, count, level }) {
				for (let i = 0; i < count; i++) {
					const centre = await map.findFreeSquare(api, 0);
					if (!centre) throw new GameError('map_full', 'Could not find free land', 503);
					await spawn(api, kind, centre, level);
				}
			},
		});
	},
});
