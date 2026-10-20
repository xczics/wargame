/**
 * Puzzles' starter content (docs/design/gameplay.md §13): where players see their puzzles (the Music House, the Items
 * page). What a completed puzzle can bring is the `rewards` register (kinds from `starter-rewards`).
 */
import { definePlugin } from '../../kernel';
import i18nCsv from './data/i18n.csv?raw';

export default definePlugin({
	id: 'starter-puzzles',
	version: '0.1.0',
	description: 'Where players see their puzzles (the Music House, the Items page)',
	dependsOn: ['puzzles', 'items', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const puzzles = ctx.services.get('puzzles');
		const items = ctx.services.get('items');

		// Where players see their puzzles: a card each on the Items page (group "Puzzles"), the whole board in the Music House.
		const ui = ctx.services.get('ui');
		ui.entry({
			kind: 'building',
			types: ['music-house'],
			widget: 'puzzles.board',
			order: 60,
			props: { view: 'puzzles.mine', views: ['puzzles.album'], catalog: 'puzzles.catalog' },
		});
		// The Items page: a card per puzzle, assembled in the browser from the player's puzzles (web/plugins/puzzles/item-cards.ts).
		items.addCards(ctx.pluginId, async (api) => {
			const mine = await puzzles.progress(api, api.playerId);
			return mine.length ? mine : null;
		});
	},
});
