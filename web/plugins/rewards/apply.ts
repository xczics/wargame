// What rewards given to the player change in the data held in the browser (user 2026-11-20: "你告诉前端成功了，前端不就
// 能更新了吗？"): each by the part of its kind at "rewards.apply" (the plugins defining the kinds know what they change);
// a kind without one, and a pool (which option was drawn only the server knows), make old what its options would change.
import type { Reward, RewardApply, RewardApplyPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';

/** Apply each reward to the data held (`to`), by the parts at "rewards.apply". */
export function applyRewards(list: readonly Reward[], to: RewardApply) {
	const parts = to.get.parts<RewardApplyPart>('rewards.apply');
	for (const r of list) parts.get(r.kind)?.(r.config, to);
}

/** What a reward may have changed, all of it made old (its views are asked for again where they show next). */
export const staleOnly = (to: RewardApply): RewardApply => ({ ...to, patchView: (view) => to.markStale(view) });

export const applyParts = [
	// One of several, drawn on the server: whatever any of them would change is old.
	defineClientPart<RewardApplyPart>({
		point: 'rewards.apply',
		id: 'pool',
		part: (options, to) => applyRewards(options as Reward[], staleOnly(to)),
	}),
];
