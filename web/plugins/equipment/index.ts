// Equipment: on the Heroes page, what a hero wears and the bag (wear, take off, smelt).
import { defineClientPlugin } from '../../core/game';
import EquipmentBlock from './EquipmentBlock.vue';
import RealmShop from './RealmShop.vue';

export default defineClientPlugin({
	id: 'equipment',
	dependsOn: ['heroes', 'settlement'],
	setup(game) {
		game.messages('zh-CN', {
			Equipment: '装备',
			'Realm shop': '秘境商店',
			'White pieces of the realms you have opened. Other colours only drop on adventures.':
				'已开启秘境的白色装备；其他颜色只能在冒险中掉落。',
			'Accessories ({n})': '饰品（{n}）',
			'Empty: wear one from the storage below': '空：从下方存放处选一件佩戴',
			'Dismantle this piece?': '拆解这件装备？',
			'Dismantle ({value})': '拆解（{value}）',
			'Not for sale (open the realms that drop it)': '不出售（需先开启掉落它的秘境）',
			'Needs a hero of level {0}': '需要英雄 {0} 级',
			'This hero wears at most {0} of these': '这名英雄最多佩戴 {0} 件',
			'This hero cannot wear these': '这名英雄不能佩戴',
			Accessory: '饰品',
			'Lv {n}': '{n}级',
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
			'stat:battle.attack': '带兵 / 守城每路攻击',
			'stat:battle.defense': '带兵 / 守城每路防御',
		});
		game.need('equipment.bag', 'starter-equipment.shop');
		// Where they go is declared by the server (meta `ui`).
		game.widget('equipment.realm-shop', RealmShop);
		game.widget('equipment.block', EquipmentBlock);
	},
});
