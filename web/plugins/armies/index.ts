// The Armies page: troops away from home, their arrival/return times and battle reports.
// Sending troops is a server-driven form on the map (placement "tile").
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import ArmiesPage from './ArmiesPage.vue';

export default defineClientPlugin({
	id: 'armies',
	dependsOn: ['settlement'],
	setup(game) {
		game.messages('zh-CN', {
			Armies: '行军',
			'No armies away from home. Pick a tile on the map to send troops.': '没有在外的部队。在地图上选择一个地块即可出兵。',
			outbound: '出征中',
			returning: '返程中',
			'Arrives in {t}': '{t} 后到达',
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
		});
		game.need('armies.list', 'armies.incoming', 'pvp.defenses');
		game.page('armies', 'Armies', ArmiesPage, { order: 9 });
		// Resync at the next arrival or return.
		watch(
			() =>
				Math.min(
					...(game.view('armies.list') ?? []).map((a) => (a.phase === 'outbound' ? a.arrivesAt : a.returnsAt)),
					...(game.view('armies.incoming') ?? []).map((a) => a.arrivesAt),
				),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);
	},
});
