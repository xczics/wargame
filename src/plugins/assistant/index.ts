/**
 * The official assistant (docs/design/gameplay.md §15): a "secretary in the browser". Players set goals on its page
 * (build queues, adventures, levelling, camps to raid, points to spend) and their open browser sends the same commands
 * they would, judged there from what the syncs already carry. The server only says whether it is on (a GM rule) and
 * how many commands a scan may send; it knows nothing else of it and checks every command as usual.
 */
import { csvRules, definePlugin, numberInRange, type ReadApi } from '../../kernel';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const RULES = csvRules(rulesCsv);

/** Static view `assistant.settings`: what the browsers' assistants go by. */
export interface AssistantSettings {
	enabled: boolean;
	commandsPerScan: number;
}

export default definePlugin({
	id: 'assistant',
	version: '0.1.0',
	description: 'The official assistant: a page where players set goals their browser pursues while open',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const enabled = ctx.config.define('enabled', {
			description: '1: players see the Assistant page and their browser plays for them by their goals; 0: no page, nothing runs.',
			default: () => RULES.enabled as number,
			parse: numberInRange(0, 1),
		});
		const perScan = ctx.config.define('commandsPerScan', {
			description: 'Most commands a player’s assistant sends after one sync.',
			default: () => RULES.commandsPerScan as number,
			parse: numberInRange(1, 50),
		});
		// Rules-made, so sent once a version and kept by browsers: switching it moves the rules' version on.
		ctx.statics.add({
			id: 'assistant.settings',
			compute: ({ rules }): AssistantSettings => ({
				enabled: enabled.get(rules as unknown as ReadApi) === 1,
				commandsPerScan: perScan.get(rules as unknown as ReadApi),
			}),
		});
		ctx.services.get('ui').page({
			id: 'assistant',
			label: 'Assistant',
			order: 95,
			widget: 'assistant.page',
			// What its panels show (fetched on this page only): heroes to pick, the realms to choose from.
			props: { views: ['heroes.list', 'realms.overview'] },
			when: { static: 'assistant.settings', field: 'enabled' },
		});
	},
});
