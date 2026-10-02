/**
 * Example content plugin (docs/plugin-guide.md): a watchtower building whose every level adds defence
 * to each lane of its settlement's defenders. It knows two systems only through their services
 * (`buildings`, `battle`), keeps its numbers in ./data, and lets the GM tune them (`watchtower.rules`).
 */
import { csvRules, definePlugin, numberFields } from '../../src/kernel';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';

const RULES = csvRules(rulesCsv) as { defensePerLevel: number };

export default definePlugin({
	id: 'watchtower',
	version: '0.1.0',
	description: 'Watchtower: defence for every lane per level',
	// Settlement kinds and their inner-city categories must exist before our building names them.
	dependsOn: ['buildings', 'battle', 'player-settlements'],
	setup(ctx) {
		const buildings = ctx.services.get('buildings');
		const rules = ctx.config.define('rules', {
			description: 'defensePerLevel: defence per watchtower level, in every lane.',
			default: () => RULES,
			// GM input is untrusted: numberFields checks each field and keeps the defaults for the rest.
			parse: numberFields(() => RULES, 0, 1e6),
		});

		buildings.defineFromCsv(buildingsCsv, levelsCsv);

		ctx.services.get('battle').addModifier(async (api, side) => {
			if (side.role !== 'defender' || !side.settlement) return [];
			const level = await buildings.level(api, side.settlement.id, 'watchtower');
			return level ? [{ source: 'Watchtower', stat: 'defense', flat: level * rules.get(api).defensePerLevel }] : [];
		});
	},
});
