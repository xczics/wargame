// Puzzle pieces as a reward (a GM mail's attachment, a puzzle's reward; user 2026-11-24: "拼图也要能通过附件发送"): in a
// few words at "rewards.describe", and once claimed, the puzzle data held asked for again where it shows next (which
// pieces went to the picture and which to the spares is the server's count). Pure: the tests run them.
import type { RewardApplyPart, RewardPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The puzzles plugin's words (its i18n keys).
const text = uiTexts('puzzles');

export const rewardParts = [
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'puzzle-pieces',
		part: (c) => text('Puzzle pieces ({0} of each)', { 0: (c as { count?: number }).count ?? 1 }),
	}),
	defineClientPart<RewardApplyPart>({
		point: 'rewards.apply',
		id: 'puzzle-pieces',
		part: (_c, to) => {
			to.markStale('puzzles.mine');
			to.markStale('puzzles.album');
			to.markStale('items.extra');
		},
	}),
];
