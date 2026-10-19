// Puzzles (docs/design/gameplay.md §13): the board players put together (in the Music House, where the server's layout
// puts widget "puzzles.board") and the GM's puzzle screen (a GM console tab, widget "puzzles.gm"). Pictures are cut
// and blurred here from one file; the GM's crop and scaling happen here too (never on the Worker).
import { defineClientPlugin } from '../../core/game';
import Board from './Board.vue';
import GmPuzzles from './GmPuzzles.vue';

export default defineClientPlugin({
	id: 'puzzles',
	dependsOn: ['auth', 'settlement'],
	setup(game) {
		game.messages('zh-CN', {
			Puzzles: '拼图',
			'No puzzle pieces yet: they drop in battles.': '还没有拼图碎片：打仗时会掉落。',
			'Completing it brings:': '集齐后可兑换：',
			'Any piece can be exchanged on the Items page, one at a time, for:': '碎片可以在道具页一张张兑换成：',
			'Claimed {n} of {max} times': '已兑换 {n} / {max} 次',
			'Its pieces no longer drop.': '这张拼图的碎片已不再掉落。',
			'Claim the reward': '兑换奖励',
			'Claiming…': '兑换中…',
			'For the settlement': '作用于城池',
			'Loading…': '加载中…',
			'New puzzle': '新建拼图',
			'status:draft': '草稿',
			'status:live': '上线',
			'status:closed': '停止掉落',
			'status:hidden': '下架',
			Name: '名称',
			Status: '状态',
			'Pieces a side': '每边块数',
			'Claims per player': '每人兑换上限',
			'The grid is fixed once the puzzle is out of the draft.': '拼图离开草稿状态后就不能再改网格。',
			Picture: '图片',
			Size: '大小',
			'Left / right': '左右',
			'Up / down': '上下',
			'Upload this square': '上传这个正方形',
			'Picture uploaded': '图片已上传',
			'Where pieces drop': '掉落设置',
			'Chance (%)': '概率（%）',
			'Rare pieces': '稀有碎片数',
			'Rare chance (%)': '稀有概率（%）',
			Value: '价值',
			'Spread all pieces': '全部散布',
			'Choose where first': '请先选择掉落地点',
			Pieces: '碎片',
			all: '全部',
			Remove: '删除',
			'At: {places}': '地点：{places}',
			'All {n} of these in about {rolls} rolls there': '这 {n} 块在那里大约打 {rolls} 次能集齐',
			Places: '地点',
			'Add a rule': '添加一条规则',
			Rewards: '兑换奖励',
			'Add a reward': '添加奖励',
			'Exchanging a piece (Items page) brings': '在道具页兑换一张碎片得到',
			Add: '添加',
			Save: '保存',
			Saved: '已保存',
			Weight: '权重',
			'Add an option': '添加一项',
		});
		game.widget('puzzles.board', Board);
		// The GM screen only for the GM (the console's tabs are the GM's anyway).
		if (game.use('auth').user.gm) game.widget('puzzles.gm', GmPuzzles);
	},
});
