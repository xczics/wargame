// Troops: the garrisons of all settlements on the Army page, and training on the entry of
// the building that trains each unit (which building that is comes from the unit's meta).
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import GarrisonsBlock from './GarrisonsBlock.vue';

export default defineClientPlugin({
	id: 'troops',
	dependsOn: ['settlement', 'forms', 'armies'],
	setup(game) {
		game.messages('zh-CN', {
			Troops: '部队',
			Garrisons: '各城驻军',
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
				'资源耗尽时，需要该资源的部队会逐步溃逃（或降级），直到维持开销负担得起。',
			Training: '训练中',
			'{n} training plans waiting': '另有 {n} 个训练计划排队',
			'Train troops in the barracks (open the building on the Overview page).': '在兵营里训练部队（在城池页点开兵营）。',
		});
		game.need('troops.garrison', 'troops.units', 'troops.overview');
		// Where they go is declared by the server (meta `ui`).
		game.widget('troops.garrisons', GarrisonsBlock);
		// Resync when any settlement's training finishes.
		watch(
			() =>
				Math.min(...(game.view('troops.overview') ?? []).flatMap((g) => g.training.flatMap((b) => (b.finishesAt ? [b.finishesAt] : [])))),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);
	},
});
