// Opaque research (docs/design/gameplay.md §14): the Shuangqing Temple's applications and projects (widget
// "opaque-research.temple", placed by the server's layout in the temple's entry) and the bonuses on the research page
// ("opaque-research.bonuses"). Applications' sentences are picked here from the static texts.
import { defineClientPlugin } from '../../core/game';
import Bonuses from './Bonuses.vue';
import GmGroups from './GmGroups.vue';
import GmOpaque from './GmOpaque.vue';
import Temple from './Temple.vue';

export default defineClientPlugin({
	id: 'opaque-research',
	dependsOn: ['auth'],
	setup(game) {
		game.messages('en', {
			'tier:1': 'Tier C',
			'tier:2': 'Tier B',
			'tier:3': 'Tier A',
			'tier:4': 'Major project',
			'section:background': 'Background',
			'section:content': 'Research content',
			'section:method': 'Method',
			'section:basis': 'Groundwork',
			'category:production': 'Production',
			'category:upkeep': 'Upkeep',
			'category:time': 'Time',
			'category:battle': 'Battle',
		});
		game.messages('zh-CN', {
			'tier:1': '丙级项目',
			'tier:2': '乙级项目',
			'tier:3': '甲级项目',
			'tier:4': '重大项目',
			'section:background': '研究背景',
			'section:content': '研究内容',
			'section:method': '研究方法',
			'section:basis': '研究基础',
			'Research applications': '项目申请书',
			'Nothing to approve yet.': '暂时没有可以批准的项目。',
			'Up to {tier} · projects {n} / {max}': '可批准至{tier} · 在研项目 {n} / {max}',
			'No applications: heroes posted at an institute write them.': '还没有申请书：驻守研究所的英雄会提交申请。',
			'Rate {rate}': '成功率 {rate}',
			Review: '函评报告',
			Approve: '批准',
			'Turn down': '驳回',
			'Approving…': '批准中…',
			'Turning down…': '驳回中…',
			'As many projects as the temple allows are under way.': '在研项目已达双清观的上限。',
			'Under way': '在研项目',
			'ends {at}': '{at} 结题',
			'Opaque research': '不透明科技',
			'Research projects are approved at the Shuangqing Temple in your capital.': '科研项目在首都的双清观批准。',
			'No breakthroughs yet: projects approved at the Shuangqing Temple bring them.': '还没有突破：在双清观批准的科研项目会带来加成。',
			', ': '、',
			'The 256 hidden dimensions, in groups round the ring; each group gives what is set for it.':
				'256 个隐藏维度沿环分段，每段给它设定的加成。',
			Save: '保存',
			Undo: '撤销',
			'Reset to default': '恢复默认',
			Saved: '已保存',
			'Dimensions of each group': '各段包含的维度',
			'dimensions {from}–{to}': '第 {from}–{to} 维',
			Segments: '分段',
			'Each segment is {n} dimensions in a row round the ring.': '每段是环上连续的 {n} 维。',
			'Segment {n}': '第 {n} 段',
			'Gives nothing yet.': '暂无加成。',
			'% a step': '% / 级',
			Remove: '删除',
			'Add a bonus…': '添加加成项…',
			Add: '添加',
			'Copy to segment': '复制到第几段',
			Copy: '复制',
			'category:production': '产出',
			'category:upkeep': '维持费',
			'category:time': '时间',
			'category:battle': '战斗',
		});
		game.widget('opaque-research.temple', Temple);
		game.widget('opaque-research.bonuses', Bonuses);
		// The GM's ring editor for the groups rule (the rules page shows it for the GM only).
		if (game.use('auth').user.gm) {
			game.widget('opaque-research.gm-groups', GmGroups);
			game.widget('opaque-research.gm', GmOpaque);
		}
	},
});
