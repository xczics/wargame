// Resources of the selected settlement in the bottom status band, interpolated between syncs using
// production rates (up to the storage cap). Provides the "resources" service.
import { defineClientPlugin } from '../../core/game';
import ResourceBar from './ResourceBar.vue';
import { views } from './views';

export interface ResourcesService {
	/** Live (interpolated) amount in the selected settlement. Reactive. */
	current(id: string): number;
	canAfford(cost: Record<string, number>): boolean;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		resources: ResourcesService;
	}
}

export default defineClientPlugin({
	id: 'resource-bar',
	setup(game) {
		game.messages('zh-CN', {
			'Cap {0}': '上限 {0}',
			'{0}: {1} / cap {2}': '{0}：{1} / 上限 {2}',
			'Production +{0}/s': '产出 +{0}/s',
			'Production +{0}/s × {1}': '产出 +{0}/s × {1}',
			'Bonus {0}{1}/s': '加成 {0}{1}/s',
			'Upkeep −{0}/s': '维持 −{0}/s',
			'In deficit (limit −{0})': '亏空（下限 −{0}）',
			full: '爆仓',
		});
		game.need('resources.pool');
		const current = (id: string) => {
			const pool = game.view('resources.pool');
			if (!pool) return 0;
			const base = pool.amounts[id] ?? 0;
			const rate = pool.rates[id] ?? 0;
			// From the pool's own time: it is not sent again while nothing changed it (game.serverNow follows the clock).
			const seconds = Math.max(0, (game.serverNow() - pool.at) / 1000);
			if (rate > 0) return base >= pool.capacity ? base : Math.min(pool.capacity, base + rate * seconds);
			// Same rule as the server: upkeep digs below zero only down to the debt limit.
			return Math.min(base, Math.max(-(pool.debtLimit[id] ?? 0), base + rate * seconds));
		};
		game.provide('resources', { current, canAfford: (cost) => Object.entries(cost).every(([id, n]) => current(id) >= n) });
		// "resource:<id>": the selected settlement's stock now, for static views' `needs` (e.g. a price in gold).
		game.provideCounter('resource:', (id) => current(id));
		game.widget('resources.bar', ResourceBar);
		for (const v of views) game.clientView(v.id, v);
	},
});
