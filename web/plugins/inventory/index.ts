// The Items page: the player's inventory plus the forms of usable items (placement "items",
// in the context of the selected settlement).
import { defineClientPlugin } from '../../core/game';
import ItemsPage from './ItemsPage.vue';

export default defineClientPlugin({
	id: 'inventory',
	dependsOn: ['settlement', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			Items: '道具',
			'Your inventory is empty.': '背包是空的。',
			'Usable items apply to the selected settlement: {name}.': '可使用的道具作用于当前选中的城池：{name}。',
		});
		game.need('items.inventory');
		game.page('items', 'Items', { order: 8 });
		game.block('items', 'right', ItemsPage);
	},
});
