// War reports in the mailbox: how march, defence and shortage messages look.
import { defineClientPlugin } from '../../core/game';
import DefenseReport from './DefenseReport.vue';
import MarchReport from './MarchReport.vue';
import ShortageReport from './ShortageReport.vue';

export default defineClientPlugin({
	id: 'war-reports',
	dependsOn: ['mail'],
	setup(game) {
		game.messages('zh-CN', {
			// titles
			'Victory at ({x}, {y})': '（{x}, {y}）大捷',
			'Defeat at ({x}, {y})': '（{x}, {y}）战败',
			'Report from ({x}, {y})': '（{x}, {y}）行军报告',
			'Troops arrived at {target}': '部队已抵达{target}驻扎',
			'Supplies delivered to {target}': '辎重已送达{target}',
			'Transfer failed at ({x}, {y})': '（{x}, {y}）派遣失败',
			'Settlement founded: {target}': '筑城完成：{target}',
			'Expedition failed at ({x}, {y})': '（{x}, {y}）筑城失败',
			'{settlement} was raided by {name}': '{settlement}遭到{name}劫掠',
			'{settlement} repelled an attack by {name}': '{settlement}击退了{name}的进攻',
			'Troops deserted {settlement}: out of {resource}': '{settlement}部队溃逃：{resource}耗尽',
			'Troops in {settlement} lost a tier: out of {resource}': '{settlement}部队降级：{resource}耗尽',
			// bodies
			'mission:attack': '攻打',
			'mission:transfer': '派遣',
			'mission:settle': '筑城',
			victory: '胜利',
			defeat: '失败',
			'no-battle': '未交战',
			empty: '空地',
			Troops: '部队',
			Losses: '损失',
			'Enemy losses': '敌方损失',
			Loot: '战利品',
			Captured: '俘获',
			Promoted: '晋升',
			Lost: '损失',
			Taken: '被掠夺',
			Someone: '有人',
			'attack {a} vs defence {d}': '攻击 {a} 对 防御 {d}',
			'The attack was repelled': '成功击退进攻',
			'The attackers won': '进攻方获胜',
			'Out of {resource}': '{resource}耗尽',
			Deserted: '溃逃',
			'Supplies delivered': '辎重已送达',
			'Supplies brought back': '辎重带回',
			'Dropped a tier': '降级',
			'Until income covers upkeep again, a little more leaves every round.': '在产出重新覆盖维持开销之前，每一轮都会再损失一部分。',
			// lanes
			'Lane by lane': '分路战况',
			Result: '结果',
			'grade:crushing': '大胜',
			'grade:victory': '胜',
			'grade:narrow': '险胜',
			'grade:narrow-defeat': '险败',
			'grade:routed': '溃败',
			'{a} lanes to {b}': '{a} 路比 {b} 路',
			'losses ×{f}': '伤亡 ×{f}',
			Us: '我方',
			Them: '敌方',
			counters: '克制',
			'Our bonuses': '我方加成',
			'Their bonuses': '敌方加成',
			attack: '攻击',
			defense: '防御',
			hp: '生命',
			counter: '相克',
			casualty: '伤亡',
			Stockade: '营寨',
			'Lane losses are before the casualty factor; the totals above are after it.':
				'分路损失为乘伤亡系数之前的数值，上方的合计为乘系数之后。',
		});
		const mail = game.use('mail');
		mail.renderer('war-reports.march', MarchReport);
		mail.renderer('war-reports.defense', DefenseReport);
		mail.renderer('war-reports.shortage', ShortageReport);
	},
});
