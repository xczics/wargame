/**
 * Walls and hidden stores (docs/design/gameplay.md §3.4, §3.9); the data is in ./data (CSV).
 *
 * - Walls: every player settlement has one, level 1 from the day it is founded. Each level
 *   adds base defence to every defending lane (more for resource fortresses, which have no
 *   garrison), and every few levels a defence bonus, up to a maximum.
 * - Hidden stores keep part of every resource out of raiders' reach (the pvp plugin's
 *   `pvp.protected` stat).
 *
 * This content plugin connects buildings, settlements (placing the wall at founding), battle
 * (wall defence, as a battle modifier) and pvp; none of those systems knows about walls.
 */
import { csvNumber, csvRows, csvRules, definePlugin, numberFields, numberInRange, recordOf, type EngineApi } from '../../kernel';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import walledCsv from './data/walled.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
			return [{ source: `Wall Lv ${level}`, stat: 'defense', flat, ...(percent ? { percent } : {}) }];
		});

		const hidden = ctx.config.define('hiddenStore', {
			description: 'Amount of every resource each hidden store level keeps from raiders.',
			default: () => RULES.hiddenStore.perLevel as number,
			parse: numberInRange(0, 1e12),
		});
		stats.contribute('pvp.protected', async (api, target) => {
			if (!target.startsWith('settlement:')) return null;
			const level = await buildings.level(api as EngineApi, target.slice('settlement:'.length), HIDDEN);
			return level ? { flat: level * hidden.get(api) } : null;
		});
	},
});
