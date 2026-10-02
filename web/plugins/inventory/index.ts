// The Items page: category filter on the left; on the right a grid of items, or the opened one with its use form (placement "items",
// in the context of the selected settlement).
import { defineClientPlugin } from '../../core/game';
import InventoryList from './InventoryList.vue';
import ItemShortcuts from './ItemShortcuts.vue';
import ItemsPage from './ItemsPage.vue';

export default defineClientPlugin({
	id: 'inventory',
	dependsOn: ['settlement', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			Items: '道具',
			'Your inventory is empty.': '背包是空的。',
			All: '全部',
			'All items': '全部道具',
			'item-category:resources': '资源',
			'item-category:speed-ups': '加速',
			'item-category:production': '增产',
			'item-category:heroes': '英雄',
			'item-category:building': '城建',
			'item-category:keys': '钥匙',
			'item-category:misc': '杂物',
			'This item is not used from here.': '这件道具不在这里使用。',
			'You have none.': '背包里没有。',
			'It can be found on realm adventures.': '可以在秘境冒险中获得。',
			'Buy it in the shop': '去聚宝阁购买',
			'Usable items apply to the selected settlement: {name}.': '可使用的道具作用于当前选中的城池：{name}。',
		});
		game.need('items.inventory');
		// Where they go is declared by the server (meta `ui`).
		game.widget('items.list', InventoryList);
		game.widget('items.page', ItemsPage);
		// Items that show a button elsewhere (their `shortcuts`): the server puts this on those entries and pages.
		game.widget('items.shortcuts', ItemShortcuts);
	},
});
