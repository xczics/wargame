/**
 * Walls and hidden stores (docs/design/gameplay.md §3.4, §3.9); the data is in ./data (CSV).
 *
 * - Walls: every player settlement has one, level 1 from the day it is founded. Each level
 *   adds base defence to every defending lane (more for resource fortresses, which have no
 *   garrison), and every few levels a defence bonus, up to a maximum.
 * - Hidden stores keep part of every resource out of raiders' reach (the pvp plugin's
 *   `pvp.protected` stat).
 * - Permanent defence: a settlement's own base defence for every lane, given by others (e.g. a puzzle's reward:
 *   `starterDefense.addPermanent`), added after every percentage (the battle modifier's `last`). One row per
 *   settlement that has any.
 *
 * This content plugin connects buildings, settlements (placing the wall at founding), battle
 * (wall defence, as a battle modifier) and pvp; none of those systems knows about walls.
 */
import {
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	gameErrors,
	numberFields,
	numberInRange,
	type ReadApi,
	recordOf,
	stagedGrowth,
	type EngineApi,
} from '../../kernel';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import walledCsv from './data/walled.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const text = uiTexts('starter-defense');
const fail = gameErrors('starter-defense');

export interface StarterDefenseService {
	/** A settlement's permanent base defence (every lane, added after every percentage); 0 when it has none. */
	permanent(api: ReadApi, settlementId: string): Promise<number>;
	/** Add to it for good (amount > 0). Returns the new total. */
	addPermanent(api: EngineApi, settlementId: string, amount: number): Promise<number>;
}

declare module '../../kernel' {
	interface ServiceMap {
		starterDefense: StarterDefenseService;
	}
}

const WALL = 'wall';
const HIDDEN = 'hidden-store';
const RULES = csvRules(rulesCsv);
/** Settlement kinds with walls: the district holding it and the defence per wall level. */
const WALLED = new Map(csvRows(walledCsv).map((r) => [r.kind, { district: r.district, defense: csvNumber(r, 'defensePerLevel') }]));

export default definePlugin({
	id: 'starter-defense',
	version: '0.2.0',
	description: 'Walls (defence per level, a bonus every few levels) and hidden stores',
	dependsOn: ['buildings', 'settlements', 'battle', 'player-settlements', 'stats', 'pvp', 'i18n'],
	tables: ['starter_defense_permanent'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const battle = ctx.services.get('battle');

		buildings.defineFromCsv(buildingsCsv, levelsCsv);
		for (const [kind, { district }] of WALLED) settlements.allowCategory(kind, district, 'defense');
		// The defence formation is set on the wall.
		battle.addFormationSite(WALL);

		// A new settlement gets one more slot in its wall district, holding a level-1 wall.
		settlements.onFounded(async (api, s) => {
			const walled = WALLED.get(s.kind);
			if (!walled || !s.ownerId) return;
			const centre = s.districts.find((d) => d.type === walled.district);
			if (!centre) return;
			await settlements.addSlots(api, s.id, centre.id, 1);
			await buildings.place(api, s.id, centre.id, centre.slots - 1, WALL, 1);
		});

		const DEFENSE = Object.fromEntries([...WALLED].map(([kind, w]) => [kind, w.defense]));
		const defense = ctx.config.define('wallDefense', {
			description: 'Base defence each wall level adds to every lane, by settlement kind (partial overrides allowed).',
			default: () => DEFENSE,
			parse: (raw) => ({ ...DEFENSE, ...recordOf(() => WALLED.keys(), numberInRange(0, 1e9))(raw) }),
		});
		const bonus = ctx.config.define('wall', {
			description: 'Wall defence bonus: +bonusStep% every bonusEvery levels, at most bonusMax%.',
			default: () => RULES.wall as Record<string, number>,
			parse: numberFields(() => RULES.wall),
		});
		// Other plugins strengthen walls (e.g. fortification research: percent on `wallStrength`) or
		// breach them (`wallBreach`: percentage points of the wall's bonus an attacker ignores).
		const stats = ctx.services.get('stats');
		stats.define({ id: 'starter-defense.wallStrength', description: 'wall defence', base: () => 1, min: 0 });
		stats.define({ id: 'starter-defense.wallBreach', description: 'wall bonus ignored', base: () => 0, min: 0 });
		battle.addModifier(async (api, side, fight) => {
			if (side.role !== 'defender' || !side.settlement?.ownerId) return [];
			const level = await buildings.level(api, side.settlement.id, WALL);
			if (!level) return [];
			const b = bonus.get(api);
			const breach = fight.attacker.playerId ? await stats.get(api, 'starter-defense.wallBreach', `player:${fight.attacker.playerId}`) : 0;
			const percent = Math.max(0, Math.min(b.bonusMax, Math.floor(level / Math.max(1, b.bonusEvery)) * b.bonusStep) - breach);
			const strength = await stats.get(api, 'starter-defense.wallStrength', settlements.entity(side.settlement.id));
			const flat = level * (defense.get(api)[side.settlement.kind] ?? 0) * strength;
			return [{ source: text('Wall Lv {0}', { 0: level }), stat: 'defense', flat, ...(percent ? { percent } : {}) }];
		});
		// Permanent defence: read once a call (the wall's card and a battle both want it); no row = none.
		const loadPermanent = (api: ReadApi, settlementId: string) =>
			api.memo(`starter-defense:permanent:${settlementId}`, async () => ({
				defense:
					(
						await api.db
							.prepare('SELECT defense FROM starter_defense_permanent WHERE settlement_id = ?')
							.bind(settlementId)
							.first<{ defense: number }>()
					)?.defense ?? 0,
			}));
		const service: StarterDefenseService = {
			permanent: async (api, settlementId) => (await loadPermanent(api, settlementId)).defense,
			async addPermanent(api, settlementId, n) {
				if (!(n > 0) || !Number.isFinite(n)) throw fail('bad_payload', 'Expected a positive amount');
				const row = await loadPermanent(api, settlementId);
				row.defense += n;
				api.write(
					api.db
						.prepare(
							'INSERT INTO starter_defense_permanent (settlement_id, defense) VALUES (?, ?) ON CONFLICT (settlement_id) DO UPDATE SET defense = excluded.defense',
						)
						.bind(settlementId, row.defense),
				);
				return row.defense;
			},
		};
		ctx.services.provide('starterDefense', service);
		// After every percentage (walls', research's, heroes'...): the battle's `last`.
		battle.addModifier(async (api, side) => {
			if (side.role !== 'defender' || !side.settlement?.ownerId) return [];
			const n = await service.permanent(api, side.settlement.id);
			return n > 0 ? [{ source: text('Permanent defence'), stat: 'defense', last: n }] : [];
		});

		// What a wall level gives, on its card (the attacker's breach aside), and the settlement's permanent defence: the
		// numbers; the client plugin words them (web/plugins/starter-defense/effects.ts).
		buildings.addEffects(WALL, async (api, s, level) => {
			const b = bonus.get(api);
			const strength = await stats.get(api, 'starter-defense.wallStrength', settlements.entity(s.id));
			return {
				defense: level * (defense.get(api)[s.kind] ?? 0) * strength,
				percent: Math.min(b.bonusMax, Math.floor(level / Math.max(1, b.bonusEvery)) * b.bonusStep),
				// The percent comes in steps (every few levels, up to a cap): where the next is, so it does not read as per level.
				every: Math.max(1, b.bonusEvery),
				step: b.bonusStep,
				max: b.bonusMax,
				permanent: await service.permanent(api, s.id),
			};
		});

		const hiddenRule = ctx.config.define('hiddenStore', {
			description:
				'What a hidden store keeps from raiders, of every resource: perLevel a level to level 5, then from level from1 each level x factor1, from from2 x factor2.',
			default: () => RULES.hiddenStore as Record<string, number>,
			parse: numberFields(() => RULES.hiddenStore as Record<string, number>, 0, 1e12),
		});
		/** What a hidden store of `level` keeps, of every resource (the warehouse's curve: linear, then faster). */
		const hidden = (api: ReadApi, level: number) => {
			const h = hiddenRule.get(api);
			return stagedGrowth(h.perLevel, level, [
				{ from: h.from1, factor: h.factor1 },
				{ from: h.from2, factor: h.factor2 },
			]);
		};
		buildings.addEffects(HIDDEN, async (api, _s, level) => ({ keeps: hidden(api, level) }));
		stats.contribute('pvp.protected', async (api, target) => {
			const id = settlements.idOf(target);
			if (!id) return null;
			const level = await buildings.level(api as EngineApi, id, HIDDEN);
			return level ? { flat: hidden(api, level) } : null;
		});
	},
});
