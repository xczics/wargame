// Research: the Research page shows the tech tree and everything being researched in all
// settlements; research is started on the entry of a lab building (e.g. the institute,
// which buildings those are comes from the server's meta).
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import LabBlock from './LabBlock.vue';
import QueueBlock from './QueueBlock.vue';
import TreeBlock from './TreeBlock.vue';

export default defineClientPlugin({
	id: 'research',
	dependsOn: ['settlement', 'resource-bar'],
	setup(game) {
		game.messages('zh-CN', {
			Research: '科技',
			Lv: '等级',
			'finishing…': '即将完成…',
			'Research Lv {n}': '研究 {n} 级',
			'Researching in {name} (speed ×{speed}); costs are paid by it.': '在{name}研究（速度 ×{speed}），费用由其支付。',
			'Research queue': '研究队列',
			'Tech tree': '科技树',
			'Researching Lv {n}': '正在研究 {n} 级',
			'per level': '/ 级',
			'only {family}': '（仅{family}）',
			'{building} levels {from}–{to}': '解锁{building} {from}–{to} 级',
			'Start research at an institute (open it on the Overview page). Tags: prerequisites in the other branch.':
				'在研究所里开始研究（在城池页点开研究所）。虚线标签：另一门类的前置科技。',
			'Nothing is being researched. Start research at an institute (open it on the Overview page).':
				'没有正在进行的研究。在研究所里开始研究（在城池页点开研究所）。',
		});
		game.need('research.tree');
		game.page('research', 'Research', { order: 5 });
		game.block('research', 'left', QueueBlock, { order: 10 });
		game.block('research', 'right', TreeBlock);
		const labs = game.meta.researchLabs ?? [];
		if (labs.length) game.entryBlock('building', LabBlock, { types: labs, order: -50 });
		// Resync when any settlement's research finishes.
		watch(
			() => Math.min(...(game.view('research.tree')?.all ?? []).map((j) => j.finishesAt)),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);
	},
});
