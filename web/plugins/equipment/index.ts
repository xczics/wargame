// Equipment: on the Heroes page, what a hero wears and the bag (wear, take off, smelt).
import { defineClientPlugin } from '../../core/game';
import EquipmentBlock from './EquipmentBlock.vue';

export default defineClientPlugin({
	id: 'equipment',
	dependsOn: ['heroes', 'settlement'],
	setup(game) {
		game.messages('zh-CN', {
			Equipment: '装备',
			'Stored here {n} / {cap}': '本城存放 {n} / {cap}',
			'Nothing stored here. Equipment drops in realms; an armory stores more.': '本城没有存放装备。装备从秘境掉落；建武库可以多存。',
			'No room to store it here (an armory stores more)': '本城放不下了（建武库可以多存）',
			'Only heroes of the settlement where it is can take it': '只有挂靠在装备所在城池的英雄能取用',
			Armory: '武库',
			Wear: '装备',
			'Take off': '卸下',
			'Smelt ({value})': '熔炼（{value}）',
			'Smelt this piece?': '熔炼这件装备？',
			'Tier {n}': '{n} 档',
			'worn by {name}': '{name}穿戴中',
			'Take it off first': '请先卸下',
			'No such piece': '没有这件装备',
			'stat:adv.attack': '冒险攻击',
			'stat:adv.defense': '冒险防御',
			'stat:adv.hp': '冒险生命',
			'stat:adv.recovery': '冒险回复（百分点）',
			'stat:battle.attack': '带兵 / 守城攻击 %',
			'stat:battle.defense': '带兵 / 守城防御 %',
		});
		game.need('equipment.bag');
		game.block('heroes', 'right', EquipmentBlock, { order: 5 });
		// Buildings that store gear (the armory) show the same on their entry.
		const storage = game.meta.equipment?.storageBuildings ?? [];
		if (storage.length) game.entryBlock('building', EquipmentBlock, { types: storage, order: -40 });
	},
});
