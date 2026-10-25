// The rewards plugin's own kind in words: a pool, "One of: …", each option by the part of its kind ("rewards.describe").
import type { Reward, RewardPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { literal, uiTexts } from '../../../src/shared/i18n';

// The rewards plugin's own words (its i18n keys).
const text = uiTexts('rewards');

export const parts = [
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'pool',
		part: (options, get) =>
			text('One of: {0}', {
				0: (options as Reward[]).map((o) => get.parts<RewardPart>('rewards.describe').get(o.kind)?.(o.config, get) ?? literal(o.kind)),
			}),
	}),
];
