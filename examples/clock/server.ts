/**
 * Example extension with a client widget of its own (docs/plugin-guide.md, "扩展"): the server's time in
 * the bottom band, ticking. The server keeps the setting (GM rule `clock.utcOffset`) and says where the
 * widget goes; ./client.ts registers the widget, which counts with `game.elapsed`. No official file changes.
 *
 * To try it, copy this folder to `extensions/clock/` (both ends pick it up at build time).
 */
import { definePlugin, numberInRange } from '../../src/kernel';
import i18nCsv from './data/i18n.csv?raw';
import type { ClockSettings } from './types';

export default definePlugin({
	id: 'clock',
	version: '0.1.0',
	description: "Example: the server's time in the bottom band, drawn by a client widget of its own",
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const offset = ctx.config.define('utcOffset', {
			description: 'Hours added to UTC for the clock (-12 to 14).',
			default: () => 8,
			parse: numberInRange(-12, 14),
		});
		ctx.views.add({ id: 'clock.settings', compute: async (api): Promise<ClockSettings> => ({ utcOffset: offset.get(api) }) });
		ctx.services.get('ui').band({ band: 'bottom', widget: 'clock.time', order: 100, props: { view: 'clock.settings' } });
	},
});
