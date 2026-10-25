/**
 * Example extension (docs/plugin-guide.md, "扩展"): an "otherworld" — a small 5 x 5 grid of its own on a
 * page of its own. The generic `ui.grid` draws it with no client code; a cell's button runs a command, and the
 * command's mail (data only) is shown by the generic `ui.report`, worded by the client half (./client.ts).
 *
 * To try it, copy this folder to `extensions/otherworld/` (both ends pick it up at build time).
 */
import { definePlugin, fields, gameErrors, shape } from '../../src/kernel';
import type { GridCell, GridData } from '../../src/shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../src/shared/i18n';

const fail = gameErrors('otherworld');
const text = uiTexts('otherworld');

const SIZE = 5;
/** Who lives where: a fixed little world, so the example stays readable. */
const DWELLERS: Record<string, { icon: string; name: string }> = {
	'4,4': { icon: '👹', name: 'Mountain demon' },
	'1,3': { icon: '🦊', name: 'Fox spirit' },
	'3,0': { icon: '🐍', name: 'White snake' },
};

export default definePlugin({
	id: 'otherworld',
	version: '0.1.0',
	description: 'Example: a small grid world of its own, drawn by the generic grid widget',
	dependsOn: ['ui', 'mail', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const own = ctx.services.get('i18n').scope();
		const mail = ctx.services.get('mail');

		ctx.views.add({
			id: 'otherworld.grid',
			async compute(_api, params): Promise<GridData> {
				const at = (v: string | undefined) => Math.min(SIZE - 1, Math.max(0, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 2));
				const cells: GridCell[] = [];
				for (let y = 0; y < SIZE; y++)
					for (let x = 0; x < SIZE; x++) {
						const d = DWELLERS[`${x},${y}`];
						cells.push({
							x,
							y,
							fill: 'terrain-desert',
							...(d
								? {
										icon: d.icon,
										tone: 'enemy' as const,
										title: [keyText(d.name)],
										info: [{ text: keyText(d.name) }],
										actions: [{ command: 'otherworld.scout', payload: { x, y }, label: text('Scout it') }],
									}
								: {}),
						});
					}
				return {
					title: text('Otherworld'),
					minX: 0,
					minY: 0,
					width: SIZE,
					height: SIZE,
					wrap: false,
					centre: { x: at(params.x), y: at(params.y) },
					radius: 2,
					cells,
				};
			},
		});

		// Sends the player a note about what lives there: no state of its own, so it is safe to retry.
		ctx.commands.add<{ x: number; y: number }>({
			type: 'otherworld.scout',
			description: 'Scout a dweller of the otherworld; the report comes by mail. Payload: { "x", "y" }',
			parse: shape({ x: fields.int(-1e4, 1e4), y: fields.int(-1e4, 1e4) }, (p) => {
				if (!DWELLERS[`${p.x},${p.y}`]) throw fail('not_found', 'Nobody lives there', 404);
				return p;
			}),
			async execute(api, { x, y }) {
				const d = DWELLERS[`${x},${y}`];
				mail.send(api, api.playerId, {
					kind: 'otherworld.scouted',
					title: text('Scouted: {name}', { name: keyText(d.name) }),
					// Data only: where, and who (an icon and a name key); the client half words it.
					data: { x, y, icon: d.icon, name: own(d.name) },
				});
			},
		});

		const ui = ctx.services.get('ui');
		ui.page({
			id: 'otherworld',
			label: 'Otherworld',
			order: 11,
			widget: 'ui.grid',
			props: { gridView: 'otherworld.grid', grid: 'otherworld' },
		});
		ui.mail('otherworld.scouted', 'ui.report');
	},
});
