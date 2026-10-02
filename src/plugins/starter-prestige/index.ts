/**
 * Default prestige content (docs/design/gameplay.md §12.1): thirty ranks of office, from Commoner to
 * Chancellor of State, five of which raise the city limit (./data/ranks.csv).
 */
import { definePlugin } from '../../kernel';
import i18nCsv from './data/i18n.csv?raw';
import ranksCsv from './data/ranks.csv?raw';

export default definePlugin({
	id: 'starter-prestige',
	version: '0.1.0',
	description: 'Thirty ranks of office by prestige; five raise the city limit',
	// The city limit stat comes from the settlement kinds.
	dependsOn: ['prestige', 'player-settlements', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		ctx.services.get('prestige').defineRanksFromCsv(ranksCsv);
	},
});
