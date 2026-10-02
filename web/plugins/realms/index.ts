// Realms: a page listing the realms (send idle heroes on adventures, with a preview of how far
// they would get), what is under way and who is injured; the adventure report in the mailbox.
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import AdventureSection from './AdventureSection.vue';
import AdventuresBlock from './AdventuresBlock.vue';
import RealmReport from './RealmReport.vue';
import RealmsPage from './RealmsPage.vue';

export default defineClientPlugin({
	id: 'realms',
	dependsOn: ['heroes', 'mail', 'settlement'],
	setup(game) {
		game.messages('zh-CN', {
			Realms: '秘境',
			Adventure: '冒险',
			'Luck +{l}%': '幸运 +{l}%',
			'drops:common': '一般',
			'drops:uncommon': '偶见',
			'drops:rare': '罕见',
			'drops:clear': '通关必得',
			'Clear it once to see what it can drop.': '首次通关后显示可能的掉落。',
			Equipment: '装备',
			'On adventures': '冒险中',
			'Nobody is away.': '没有英雄在外冒险。',
			'Injured heroes': '重伤的英雄',
			'Treat ({cost}, {t})': '疗伤（{cost}，{t}）',
			'Healed in {t}': '{t} 后痊愈',
			'Back in {t}': '{t} 后归来',
			'finishing…': '即将结束…',
			Locked: '未开启',
			'Open it with its key, dropped by the hardest task of the realm before.': '需要钥匙开启：上一个秘境最难的任务必定掉落。',
			'On the map: {places}': '地图位置：{places}',
			Hero: '英雄',
			'No idle hero.': '没有空闲的英雄。',
			'{n} groups': '{n} 组',
			'strongest {a} / {d} / {h}': '最强 攻{a} / 防{d} / 命{h}',
			'exp {n}': '经验 {n}',
			'drops {p}% · {m} on average': '每组掉落率 {p}%（平均 {m} 件）',
			'Expected: clears it': '预计：可以通关',
			'Expected: falls at group {n}': '预计：在第 {n} 组倒下',
			'Set out': '出发',
			'Attack {a} · Defence {d} · HP {h} · Recovery {r}%': '攻击 {a} · 防御 {d} · 生命 {h} · 回复 {r}%',
			'Adventure in {realm}: cleared': '{realm}冒险：通关',
			'Adventure in {realm}: defeated': '{realm}冒险：失败',
			'Adventure in {realm}': '{realm}冒险',
			Group: '怪物',
			'Attack / defence / HP': '攻 / 防 / 命',
			'Hero HP': '英雄生命',
			Rewards: '奖励',
			'Experience +{n}': '经验 +{n}',
			'up {n} levels': '升 {n} 级',
			'Cleared:': '通关奖励：',
			'The hero fell and is injured: treat it at its settlement.': '英雄力竭倒下，身受重伤：请在挂靠城池疗伤。',
			'(lost: bag full)': '（行囊已满，丢失）',
		});
		game.need('realms.overview');
		// Where they go is declared by the server (meta `ui`).
		game.widget('realms.adventures', AdventuresBlock);
		game.widget('realms.page', RealmsPage);
		game.widget('realms.report', RealmReport);
		game.widget('realms.adventure', AdventureSection);
		// Have the server commit adventures and treatments as they end, so the report arrives at once.
		const next = () => {
			const o = game.view('realms.overview');
			return Math.min(
				...(o?.adventures ?? []).map((a) => a.finishesAt),
				...(o?.injured ?? []).flatMap((i) => (i.healingUntil ? [i.healingUntil] : [])),
			);
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		watch(
			next,
			(t) => {
				clearTimeout(timer);
				if (Number.isFinite(t)) timer = setTimeout(() => void game.command('realms.sync'), Math.max(0, t - game.serverNow()) + 500);
			},
			{ immediate: true },
		);
	},
});
