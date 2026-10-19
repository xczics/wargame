/**
 * Puzzles' starter content (docs/design/gameplay.md §13): where players see their puzzles (the Music House, the Items
 * page). What a completed puzzle can bring is the `rewards` register (kinds from `starter-rewards`).
 */
import { definePlugin } from '../../kernel';
import { literal, uiTexts } from '../../shared/i18n';
import i18nCsv from './data/i18n.csv?raw';

const text = uiTexts('starter-puzzles');

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
			props: { view: 'puzzles.mine', catalog: 'puzzles.catalog' },
		});
		items.addCards(async (api) => {
			const mine = await puzzles.progress(api, api.playerId);
			if (!mine.length) return null;
			return {
				group: { id: 'puzzles', label: text('Puzzles') },
				cards: mine.map((p) => ({
					id: `puzzle:${p.id}`,
					icon: '🧩',
					// The tiles show the title only: the progress goes in it.
					title: text('{0} · {1} / {2}', { 0: literal(p.name), 1: p.pieces, 2: p.grid * p.grid }),
					lines: [
						{
							text: text('Collected {0} / {1}', { 0: p.pieces, 1: p.grid * p.grid }),
							tone: p.pieces >= p.grid * p.grid ? ('info' as const) : undefined,
						},
						...(p.limit > 1 || p.claims ? [{ text: text('Claimed {0} / {1}', { 0: p.claims, 1: p.limit }), tone: 'muted' as const }] : []),
					],
					text: text('The whole picture is in the Music House.'),
				})),
			};
		});
	},
});
