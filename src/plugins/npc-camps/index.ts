/**
 * NPC settlements to raid — a skeleton showing how NPC kinds plug into `settlements`.
 *
 *   npc-fortress  well defended; beating it captures some of its troops
 *   npc-outpost   lightly defended; beating it carries off its food (which slowly regrows)
 *
 * Combat: an encounter handler for the armies plugin, fought by the battle plugin. NPC
 * defenders are fixed per kind (GM-tunable) and do not wear down: their units, in a random
 * formation each battle, and their stockade — flat defence in every lane. Spawning is a GM
 * command for now; a scheduled "world upkeep" task could call the same code later.
 */
import { csvMap, csvNumber, csvRows, csvRules, definePlugin, executeCommand, GameError, numberInRange } from '../../kernel';
import defendersCsv from './data/defenders.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import { requestContext } from '../../runtime/context';

const KINDS = ['npc-fortress', 'npc-outpost'] as const;
/** Design numbers (./data); GM overrides go on top. */
const RULES = csvRules(rulesCsv);
const DEFENDERS: Record<string, { defense: number; units: Record<string, number> }> = Object.fromEntries(
	csvRows(defendersCsv).map((r) => [r.kind, { defense: csvNumber(r, 'defense'), units: csvMap(r.units) }]),
);

export default definePlugin({
	id: 'npc-camps',
	version: '0.1.0',
	description: 'NPC fortresses (raid for troops) and outposts (raid for food)',
	dependsOn: ['settlements', 'world-map', 'armies', 'resources', 'troops', 'battle'],
	setup(ctx) {
		const settlements = ctx.services.get('settlements');
		const map = ctx.services.get('worldMap');
		const armies = ctx.services.get('armies');
		const resources = ctx.services.get('resources');
		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');

		const defenders = ctx.config.define<Record<string, { defense: number; units: Record<string, number> }>>('defenders', {
			description:
				'NPC defence per kind: "defense" is the stockade (flat defence in every lane), "units" the garrison (never lost; what can be captured). E.g. { "npc-outpost": { "defense": 30, "units": {} }, "npc-fortress": { "defense": 150, "units": { "infantry-1": 60 } } }.',
			default: () => DEFENDERS,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected an object per NPC kind');
				return Object.fromEntries(
					Object.entries(raw as Record<string, { defense?: unknown; units?: unknown }>).map(([k, v]) => {
						if (!KINDS.includes(k as never)) throw new GameError('bad_config', `Unknown NPC kind "${k}"`);
						const units = Object.fromEntries(
							Object.entries((v.units ?? {}) as Record<string, unknown>).map(([u, n]) => [u, Math.floor(numberInRange(0, 1e7)(n))]),
						);
						return [k, { defense: numberInRange(0, 1e12)(v.defense), units }];
					}),
				);
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
						if (!KINDS.includes(k as never)) throw new GameError('bad_config', `Unknown NPC kind "${k}"`);
						return [k, Math.floor(numberInRange(0, 100_000)(n))];
					}),
				);
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
		const captureRate = ctx.config.define('captureRate', {
			description: 'Share of an NPC fortress garrison captured when it is beaten (0-1).',
			default: () => RULES.captureRate as number,
			parse: numberInRange(0, 1),
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
			extra: { loot: 'food' },
		});

		// The stockade: flat defence in every lane of an NPC camp.
		battle.addModifier(async (api, side) => {
			if (side.role !== 'defender' || !side.settlement || !KINDS.includes(side.settlement.kind as never)) return [];
			const defense = defenders.get(api)[side.settlement.kind]?.defense ?? 0;
			return defense ? [{ source: 'Stockade', stat: 'defense', flat: defense }] : [];
		});

		armies.addEncounter(async (api, e) => {
			if (!e.occupant?.startsWith('settlement:')) return null;
			const camp = await settlements.get(api, e.occupant.slice('settlement:'.length));
			if (!camp || !KINDS.includes(camp.kind as never)) return null;
			// The camp's food pool changes: take part in the same optimistic lock.
			await api.lock(e.occupant);
			const d = defenders.get(api)[camp.kind] ?? { defense: 0, units: {} };
			const fight = await battle.fight(api, {
				attacker: {
					side: { role: 'attacker', playerId: e.army.playerId, settlement: await settlements.get(api, e.army.from), armyId: e.army.id },
					lanes: battle.attackerLanes(e.army.options, e.army.units),
					units: e.army.units,
				},
				// A new random formation every battle, fixed by the army id so a retried command agrees.
				defender: {
					side: { role: 'defender', playerId: null, settlement: camp },
					lanes: battle.defenderLanes(d.units, battle.randomFormation(`npc:${e.army.id}`)),
					units: d.units,
				},
			});
			const lost = fight.losses.attacker;
			const loot: Record<string, number> = {};
			const captured: Record<string, number> = {};
			if (fight.victory) {
				if (camp.kind === 'npc-outpost') {
					// Carry what the survivors can.
					const survivors = Object.fromEntries(Object.entries(e.army.units).map(([u, n]) => [u, n - (lost[u] ?? 0)]));
					const carry = troops.totals(api, survivors).carry;
					const food = Math.floor(Math.min(carry, Math.max(0, (await resources.amounts(api, e.occupant)).food ?? 0)));
					if (food > 0) {
						await resources.spend(api, e.occupant, { food });
						loot.food = food;
					}
				} else {
					for (const [u, n] of Object.entries(d.units)) {
						const c = Math.floor(n * captureRate.get(api));
						if (c > 0) captured[u] = c;
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

		ctx.commands.add<{ kind: (typeof KINDS)[number]; x: number; y: number }>({
			type: 'npc-camps.spawnAt',
			form: {
				title: 'Place an NPC camp',
				placement: 'gm',
				fields: [
					{
						name: 'kind',
						label: 'Kind',
						type: 'select',
						required: true,
						options: KINDS.map((k) => ({ value: k, label: k === 'npc-fortress' ? 'NPC fortress' : 'NPC outpost' })),
					},
					{ name: 'x', label: 'x', type: 'number', required: true, min: -511, max: 512 },
					{ name: 'y', label: 'y', type: 'number', required: true, min: -511, max: 512 },
				],
				submitLabel: 'Place',
			},
			privileged: true,
			description: 'Place one NPC settlement on a chosen free tile.',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (!KINDS.includes(p.kind as never)) throw new GameError('bad_payload', `kind must be one of: ${KINDS.join(', ')}`);
				const x = Number(p.x);
				const y = Number(p.y);
				if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'x and y must be integers');
				return { kind: p.kind as (typeof KINDS)[number], x: map.wrap(x), y: map.wrap(y) };
			},
			async execute(api, { kind, x, y }) {
				await settlements.found(api, { kind, ownerId: null, name: settlements.kind(kind).name, centre: { x, y } });
			},
		});

		ctx.commands.add<{ kind: (typeof KINDS)[number]; count: number }>({
			type: 'npc-camps.spawn',
			form: {
				title: 'Spawn NPC camps at random',
				placement: 'gm',
				fields: [
					{
						name: 'kind',
						label: 'Kind',
						type: 'select',
						required: true,
						options: KINDS.map((k) => ({ value: k, label: k === 'npc-fortress' ? 'NPC fortress' : 'NPC outpost' })),
					},
					{ name: 'count', label: 'Count', type: 'number', required: true, min: 1, max: 20, default: 5 },
				],
				submitLabel: 'Spawn',
			},
			privileged: true,
			description: 'Place NPC settlements on random free tiles. Payload: { "kind": "npc-outpost" | "npc-fortress", "count": 5 }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (!KINDS.includes(p.kind as never)) throw new GameError('bad_payload', `kind must be one of: ${KINDS.join(', ')}`);
				return { kind: p.kind as (typeof KINDS)[number], count: Math.floor(numberInRange(1, 20)(p.count ?? 1)) };
			},
			async execute(api, { kind, count }) {
				const name = settlements.kind(kind).name;
				for (let i = 0; i < count; i++) {
					const centre = await map.findFreeSquare(api, 0);
					if (!centre) throw new GameError('map_full', 'Could not find free land', 503);
					await settlements.found(api, { kind, ownerId: null, name, centre });
				}
			},
		});
	},
});
