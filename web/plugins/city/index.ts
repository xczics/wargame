// The City page: districts (inner city, outer cities / fortress core), their building
// slots, construction progress and build/upgrade actions. Simple actions (new outer city,
// rename, ...) come from server-driven forms (placement "settlement").
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import CityPage from './CityPage.vue';

export default defineClientPlugin({
	id: 'city',
	dependsOn: ['settlement', 'resource-bar', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			// Not "City": that source string is the settlement kind (分城).
			Overview: '城池',
			'build queue': '建造队列',
			'outer cities': '外城',
			'can garrison troops': '可驻军',
			'Inner city': '内城',
			'Outer city {n}': '外城 {n}',
			Fortress: '要塞',
			'Empty slot {n}': '空栏位 {n}',
			'Build…': '建造…',
			Cancel: '取消',
			Upgrade: '升级',
			'Now:': '当前：',
			'finishing…': '即将完成…',
			'Need {n} more {r}': '还差 {n} {r}',
			'Cancel this construction? Only part of the cost is refunded.': '取消建造？只会返还部分费用。',
		});
		game.need('settlements.detail');
		// Resync the moment the next construction finishes, so the queue and levels update.
		watch(
			() => game.view('settlements.detail'),
			(detail) => {
				const next = Math.min(
					...(detail?.districts ?? []).flatMap((d) => d.slots.flatMap((s) => (s.construction ? [s.construction.finishesAt] : []))),
				);
				if (Number.isFinite(next)) game.refreshAt(next);
			},
		);
		game.page('city', 'Overview', CityPage, { order: 0 });
	},
});
