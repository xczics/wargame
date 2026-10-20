// The bandits plugin's views assembled in the browser (src/shared/client-views.ts).
import type { BanditsState } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';
import type { TimersData } from '../../../src/shared/ui';

// The bandits plugin's own words (its i18n keys).
const text = uiTexts('bandits');

/** How long bands stay away, on the Army page while it lasts (the generic timers widget hides an empty list). */
export function protectionTimers(state: BanditsState | undefined): TimersData | undefined {
	if (state === undefined) return undefined;
	const until = state.protectedUntil;
	return {
		title: text('Bandits'),
		items: until ? [{ id: 'bandits.protection', icon: '🛡️', title: text('Safe from bandits'), endsAt: until }] : [],
	};
}

export const views = [
	defineClientView({
		id: 'bandits.protection',
		needs: ['bandits.state'],
		compute: (get) => protectionTimers(get.data<BanditsState>('bandits.state')),
	}),
];
