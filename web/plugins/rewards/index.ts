// Rewards in the browser: the pool kind's words (./describe.ts) and what it changes in the data held here (./apply.ts);
// the other kinds' come from the plugins defining them. Plugins that hand rewards out (mail, puzzles) apply what a claim
// gave through the service `rewards`.
import type { Reward } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { applyParts, applyRewards } from './apply';
import { parts } from './describe';

export interface RewardsClient {
	/** Rewards the player was just given (a claim went through): changed in the data held here, by their kinds. */
	given(list: readonly Reward[], options?: { times?: number; settlement?: string }): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		rewards: RewardsClient;
	}
}

export default defineClientPlugin({
	id: 'rewards',
	setup(game) {
		for (const p of [...parts, ...applyParts]) game.clientPart(p);
		game.provide('rewards', {
			given(list, { times = 1, settlement } = {}) {
				applyRewards(list, {
					patchView: (view, change) => game.patchView(view, change),
					markStale: (view) => game.markStale(view),
					get: game.input(),
					times,
					...(settlement ? { settlement } : {}),
				});
			},
		});
	},
});
