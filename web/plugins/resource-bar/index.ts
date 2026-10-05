// Resources of the selected settlement in the bottom status band, interpolated between syncs using
// production rates (up to the storage cap). Provides the "resources" service.
import { defineClientPlugin } from '../../core/game';
import ResourceBar from './ResourceBar.vue';

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
			cap: '上限',
			production: '产出',
			bonus: '加成',
			full: '爆仓',
			upkeep: '维持',
			'in deficit': '亏空',
			limit: '下限',
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
	},
});
