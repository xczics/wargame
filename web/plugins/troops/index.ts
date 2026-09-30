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
			hp: '生命',
			Strength: '战力',
			attack: '攻击',
			defense: '防御',
			'{0} shortage': '{0}短缺',
			Upkeep: '维持费',
			'— if a resource runs out, troops that need it leave (or drop a tier) bit by bit until upkeep fits.':
				'——资源耗尽时，需要该资源的部队会逐步溃逃（或降级），直到维持开销负担得起。',
			Training: '训练中',
		});
		game.need('troops.garrison', 'troops.units');
		game.page('troops', 'Troops', { order: 7 });
		game.block('troops', 'right', TroopsPage);
		watch(
			() => game.view('troops.garrison')?.training?.finishesAt,
			(t) => t && game.refreshAt(t),
		);
	},
});
