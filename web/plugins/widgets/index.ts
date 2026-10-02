// The generic widgets (web/widgets/): any server plugin can declare them with a view of the matching
// shape (src/shared/ui.ts) — no client code of its own needed.
import { defineClientPlugin } from '../../core/game';
import Badge from '../../widgets/Badge.vue';
import Cards from '../../widgets/Cards.vue';
import Filters from '../../widgets/Filters.vue';
import Rows from '../../widgets/Rows.vue';
import Timers from '../../widgets/Timers.vue';

export default defineClientPlugin({
	id: 'widgets',
	setup(game) {
		game.messages('zh-CN', { All: '全部', '×{n}': '×{n}' });
		game.widget('ui.badge', Badge);
		game.widget('ui.cards', Cards);
		game.widget('ui.filters', Filters);
		game.widget('ui.timers', Timers);
		game.widget('ui.rows', Rows);
	},
});
