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
		// The Items page (user 2026-10-19: "背包里，拼图合并显示，点进去，再直接排列（不要按图片网格了，按普通道具的网格），每个多少张。
		// 然后再点击，就是兑换单张。"): a card per puzzle; opened, its pieces as tiles with how many of each, a spare one
		// exchanged with a click.
		items.addCards(async (api) => {
			const mine = await puzzles.progress(api, api.playerId);
			if (!mine.length) return null;
			return {
				group: { id: 'puzzles', label: text('Puzzles') },
				cards: mine.map((p) => {
					const spares = p.held.reduce((n, h) => n + h.spares, 0);
					return {
						id: `puzzle:${p.id}`,
						icon: '🧩',
						// The tiles show the title only: the progress goes in it.
						title: text('{0} · {1} / {2}', { 0: literal(p.name), 1: p.pieces, 2: p.grid * p.grid }),
						lines: [
							{
								text: text('Collected {0} / {1}', { 0: p.pieces, 1: p.grid * p.grid }),
								tone: p.pieces >= p.grid * p.grid ? ('info' as const) : undefined,
							},
							...(spares ? [{ text: text('Spare pieces: {0}', { 0: spares }), tone: 'info' as const }] : []),
							...(p.limit > 1 || p.claims
								? [{ text: text('Claimed {0} / {1}', { 0: p.claims, 1: p.limit }), tone: 'muted' as const }]
								: []),
						],
						text: text('The whole picture is in the Music House.'),
						detail: {
							label: text('Pieces'),
							lines: [text('Click a piece to see what it is exchanged for.')],
							tiles: p.held.map((h) => ({
								id: `piece:${p.id}:${h.piece}`,
								icon: '🧩',
								// Its own cut of the picture, as in the Music House.
								...(p.image ? { picture: { file: p.image, grid: p.grid, piece: h.piece } } : {}),
								title: text('Piece {0}', { 0: h.name }),
								count: h.count,
								lines: h.reward ? [{ text: h.reward }] : [],
								actions: [
									{
										command: 'puzzles.exchange',
										payload: { puzzle: p.id, piece: h.piece },
										label: text('Exchange'),
										// Any piece, the player's call: asked first (one fewer of it, also for the picture).
										confirm: h.reward
											? text('Exchange one piece {0} for {1}? You will have {2} left.', { 0: h.name, 1: h.reward, 2: h.count - 1 })
											: text('Exchange one piece {0}? It brings nothing. You will have {1} left.', { 0: h.name, 1: h.count - 1 }),
										pending: text('Exchanging…'),
									},
									// More than one: how many at once (the client asks, the most as its placeholder).
									...(h.count > 1
										? [
												{
													command: 'puzzles.exchange',
													payload: { puzzle: p.id, piece: h.piece },
													label: text('Exchange several'),
													quantity: { max: Math.min(h.count, 100) },
													confirm: h.reward
														? text('Exchange {n} of piece {0} for {1} each?', { 0: h.name, 1: h.reward })
														: text('Exchange {n} of piece {0}? They bring nothing.', { 0: h.name }),
													pending: text('Exchanging…'),
												},
											]
										: []),
								],
							})),
						},
					};
				}),
			};
		});
	},
});
