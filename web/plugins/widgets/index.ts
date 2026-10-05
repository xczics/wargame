// The generic widgets (web/widgets/): any server plugin can declare them with a view of the matching
// shape (src/shared/ui.ts) — no client code of its own needed.
import { defineClientPlugin } from '../../core/game';
import Badge from '../../widgets/Badge.vue';
import Banner from '../../widgets/Banner.vue';
import Cards from '../../widgets/Cards.vue';
import Cells from '../../widgets/Cells.vue';
import Filters from '../../widgets/Filters.vue';
import Grid from '../../widgets/Grid.vue';
import Lanes from '../../widgets/Lanes.vue';
import LanesInput, { type LanesValue } from '../../widgets/LanesInput.vue';
import type { LanesInputData } from '../../../src/shared/ui';
import Report from '../../widgets/Report.vue';
import Rows from '../../widgets/Rows.vue';
import Sync from '../../widgets/Sync.vue';
import Tally from '../../widgets/Tally.vue';
import Table from '../../widgets/Table.vue';
import Timers from '../../widgets/Timers.vue';
import Tree from '../../widgets/Tree.vue';

export default defineClientPlugin({
	id: 'widgets',
	// Cards open server forms in place.
	dependsOn: ['forms'],
	setup(game) {
		game.messages('zh-CN', {
			All: '全部',
			'×{n}': '×{n}',
			', ': '，',
			Open: '打开',
			'My settlement': '我的城池',
			Go: '前往',
			'Tile ({x}, {y})': '地块 ({x}, {y})',
			'at most {0}': '最多 {0}',
			Dismiss: '知道了',
		});
		game.widget('ui.badge', Badge);
		game.widget('ui.banner', Banner);
		game.widget('ui.cards', Cards);
		game.widget('ui.filters', Filters);
		game.widget('ui.timers', Timers);
		game.widget('ui.rows', Rows);
		game.widget('ui.grid', Grid);
		game.widget('ui.tree', Tree);
		game.widget('ui.cells', Cells);
		game.widget('ui.lanes', Lanes);
		game.widget('ui.report', Report);
		game.widget('ui.sync', Sync);
		game.widget('ui.table', Table);
		// Form field editors (fields of type "widget").
		// Counts what a form's choices pick (e.g. bulk smelting); nothing goes into the payload.
		game.use('forms').widget('ui.tally', { component: Tally, payload: () => ({}) });
		game.use('forms').widget('ui.lanes-input', {
			component: LanesInput,
			// The lanes under their key, and every option's total (the lanes' plus the extra box) under its own.
			payload(value, field) {
				const v = value as LanesValue;
				const out = (field.data as LanesInputData).output;
				const total: Record<string, number> = { ...v.extra };
				for (const l of v.lanes) for (const [o, n] of Object.entries(l.counts)) total[o] = (total[o] ?? 0) + n;
				return { [out.lanes]: v.lanes.map((l) => ({ [out.group]: l.group, [out.counts]: l.counts })), [out.total]: total };
			},
		});
	},
});
