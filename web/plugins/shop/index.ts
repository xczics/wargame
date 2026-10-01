// The coupon shop page: balance and offers by category. Bought items go to the inventory
// (used on the Items page).
import { defineClientPlugin } from '../../core/game';
import ShopPage from './ShopPage.vue';

export default defineClientPlugin({
	id: 'shop',
	setup(game) {
		game.messages('zh-CN', {
			Shop: '聚宝阁',
			'{n} yuanbao': '元宝 {n}',
			'Bought items go to your inventory; use them on the Items page.': '买到的道具放进背包，在"道具"页使用。',
			'shop:resources': '资源',
			'shop:speed-ups': '加速',
			'shop:production': '增产',
			'shop:heroes': '英雄',
			'shop:building': '城建',
			Buy: '购买',
			'×{n}': '×{n}',
			'today {n} / {limit}': '今日 {n} / {limit}',
			'Not enough coupons ({0} / {1})': '元宝不足（{0} / {1}）',
			'Daily limit reached ({0} / {1})': '已达每日限购（{0} / {1}）',
			'No such offer': '没有这件商品',
		});
		game.need('shop.store');
		game.page('shop', 'Shop', { order: 8.5 });
		game.block('shop', 'right', ShopPage);
	},
});
