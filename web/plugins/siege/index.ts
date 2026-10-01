// Siege defences: on the wall's entry, its works and defences with what each costs and gives, and
// what is being built. The build / fortify forms are server forms placed below.
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import WallDefences from './WallDefences.vue';

export default defineClientPlugin({
	id: 'siege',
	dependsOn: ['settlement'],
	setup(game) {
		game.messages('zh-CN', {
			'Wall works': '城防工事',
			'Siege defences': '守城器械',
			'Lv {n}/{max}': '{n}/{max} 级',
			'next: {effect} · {cost} · {t}': '下一级：{effect} · {cost} · {t}',
			'each: {effect} · {cost} · {t} · keep {upkeep}/h': '每个：{effect} · {cost} · {t} · 维持 {upkeep}/时',
			'needs wall Lv {n}': '需要城墙 {n} 级',
			'Building: {item} ×{n} · {t}': '正在建造：{item} ×{n} · {t}',
			'Upkeep: {upkeep}/h': '维持：{upkeep}/时',
			'stat:attacker.attack': '进攻方攻击',
			'stat:defender.defense': '守方防御',
			'stat:defender.attack': '守方攻击',
			'stat:attack': '每路攻击',
			'stat:defense': '每路防御',
			'stat:hp': '每路生命',
			'Build siege defences': '建造守城器械',
			'Raise wall works': '修筑城防工事',
			Defence: '器械',
			Work: '工事',
			'Something is already being built at the wall': '城墙上已经有在建的项目',
			'Already at the highest level': '已经是最高级',
		});
		game.need('starter-siege.wall');
		game.entryBlock('building', WallDefences, { types: ['wall'], order: -30 });
		watch(
			() => game.view('starter-siege.wall')?.queue?.finishesAt,
			(t) => t && game.refreshAt(t),
		);
	},
});
