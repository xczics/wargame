// The Army page: marches (troops away from home, arrival/return times, results) on the right;
// the troops plugin puts the garrisons of all settlements on the left.
// Sending troops is a server-driven form on the map (placement "tile").
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import ArmiesPage from './ArmiesPage.vue';

export default defineClientPlugin({
	id: 'armies',
	dependsOn: ['settlement', 'mail'],
	setup(game) {
		game.messages('zh-CN', {
			Army: '军队',
			Marches: '行军',
			'No armies away from home. Pick a tile on the map to send troops.': '没有在外的部队。在地图上选择一个地块即可出兵。',
			outbound: '出征中',
			returning: '返程中',
			'Arrives in {t}': '{t} 后到达',
			Provisions: '随军粮饷',
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
			Promoted: '晋升',
			'Lane losses are before the casualty factor; the totals above are after it.':
				'分路损失为乘伤亡系数之前的数值，上方的合计为乘系数之后。',
			Recall: '召回',
			'Turn this army back? The unused provisions and everything it carries come back with it.':
				'召回这支军队？没用上的粮饷和随军携带的物资都会带回。',
			'Bringing back': '带回',
			Supplies: '辎重',
			'mission:attack': '攻打',
			'mission:transfer': '派遣',
			'mission:settle': '筑城',
			Attack: '出征攻打',
			'Transfer troops here': '派遣部队驻扎',
			'The troops stay here if it can hold a garrison; otherwise they unload the supplies and go back.':
				'部队留在此处驻扎；若该城池不能驻军，则卸下辎重后返回。',
			Transfer: '派遣',
			'{0} (supplies)': '{0}（辎重）',
			'Send expedition': '派出筑城队',
			'An expedition carries the founding materials and your supplies there. The troops stay as the garrison, or come back if the new settlement cannot hold one.':
				'筑城队带上建城材料和辎重前往。建成后部队留下驻守；若新城池不能驻军，则部队返回。',
			Stationed: '已驻扎',
			'Supplies delivered': '辎重已送达',
			'Settlement founded': '筑城完成',
			'Could not found the settlement: {0}': '筑城失败：{0}',
			'The settlement is gone': '目标城池已不存在',
			'That is your own settlement: transfer troops there instead': '这是你自己的城池，请改用"派遣"',
			'Troops can only be transferred to your own settlements': '只能派遣到自己的城池',
			'Pick another settlement': '请选择另一座城池',
			'These units can carry at most {0} supplies': '这些部队最多只能携带 {0} 辎重',
			'{0} cannot carry supplies': '{0}不能携带辎重',
			'Back home in {t}': '{t} 后返回',
			victory: '胜利',
			defeat: '失败',
			'no-battle': '未交战',
			empty: '空地',
			Losses: '损失',
			'Enemy losses': '敌方损失',
			Loot: '战利品',
			Captured: '俘获',
			'Send troops here': '派兵前往',
			From: '出发地',
			March: '出发',
			'attack {a} vs defence {d}': '攻击 {a} 对 防御 {d}',
			'Under beginner protection': '新手保护中',
			'Incoming attacks': '来袭警报',
			'{name} attacks {target} in {t}': '{name} 将在 {t} 后攻击 {target}',
			Someone: '有人',
			'Defence reports': '防守战报',
			'{name} attacked {target}': '{name} 攻击了 {target}',
			'The attack was repelled': '成功击退进攻',
			'The attackers won': '进攻方获胜',
			Lost: '损失',
			Taken: '被掠夺',
			'Full report in the mailbox': '完整战报见邮箱',
		});
		game.need('armies.list', 'armies.incoming');
		game.page('armies', 'Army', { order: 7 });
		game.block('armies', 'right', ArmiesPage);
		// When one of our armies arrives or gets home, have the server commit it right away (the
		// state only shows it in passing), so its report is in the mailbox at once. Also on load:
		// arrivals may have happened while we were away. Incoming attacks just need a refresh.
		const next = () => Math.min(...(game.view('armies.list') ?? []).map((a) => (a.phase === 'outbound' ? a.arrivesAt : a.returnsAt)));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const sync = () => void game.command('armies.sync');
		watch(
			next,
			(t, before) => {
				clearTimeout(timer);
				if (before === undefined && (game.view('armies.list') ?? []).length) sync();
				if (Number.isFinite(t)) timer = setTimeout(sync, Math.max(0, t - game.serverNow()) + 500);
			},
			{ immediate: true },
		);
		watch(
			() => Math.min(...(game.view('armies.incoming') ?? []).map((a) => a.arrivesAt)),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);
	},
});
