// The Troops page: the selected settlement's garrison, its upkeep and training. The
// training form itself is server-driven (placement "troops").
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import TroopsPage from './TroopsPage.vue';

export default defineClientPlugin({
	id: 'troops',
	dependsOn: ['settlement', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			Troops: '部队',
			'This kind of settlement cannot hold troops.': '这类城池不能驻军。',
			'No troops stationed here.': '此处没有驻军。',
			atk: '攻',
			def: '防',
			Strength: '战力',
			attack: '攻击',
			defense: '防御',
			'{0} shortage': '{0}短缺',
			Upkeep: '维持费',
			'— if a resource runs out, troops that need it desert.': '——资源耗尽时，需要该资源的部队会逃散。',
			Training: '训练中',
		});
		game.need('troops.garrison');
		game.page('troops', 'Troops', TroopsPage, { order: 7 });
		watch(
			() => game.view('troops.garrison')?.training?.finishesAt,
			(t) => t && game.refreshAt(t),
		);
	},
});
