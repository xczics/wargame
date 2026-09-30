// The Research page: technologies, their next level, and the research in progress.
import { watch } from 'vue';
import { defineClientPlugin } from '../../core/game';
import ResearchPage from './ResearchPage.vue';

export default defineClientPlugin({
	id: 'research',
	dependsOn: ['settlement', 'resource-bar'],
	setup(game) {
		game.messages('zh-CN', {
			Research: '科技',
			Lv: '等级',
			'finishing…': '即将完成…',
			'Research Lv {n}': '研究 {n} 级',
			'{name} has no institute. Build one in its inner city to research here — each settlement has its own research queue.':
				'{name}没有研究所。在内城建造研究所后即可在此研究——每座城池有独立的研究队列。',
			'Researching in {name} (speed ×{speed}); costs are paid by it.': '在{name}研究（速度 ×{speed}），费用由其支付。',
		});
		game.need('research.tree');
		game.page('research', 'Research', ResearchPage, { order: 5 });
		// Resync when any settlement's research finishes.
		watch(
			() => Math.min(...(game.view('research.tree')?.all ?? []).map((j) => j.finishesAt)),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);
	},
});
