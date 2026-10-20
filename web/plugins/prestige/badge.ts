// Rank and prestige next to the user name (`prestige.badge`, generic badge widget), assembled in the browser (AGENTS.md:
// the server sends data only) from the player's prestige (`prestige.status`). Pure: the tests run it. The tooltip says
// how far the next rank is.
import type { PrestigeStatus } from '../../../src/shared/api';
import { whole } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { BadgeData } from '../../../src/shared/ui';

// The prestige plugin's own words (its i18n keys): the badge reads as it did when the server built it.
const text = uiTexts('prestige');

export function prestigeBadge(s: PrestigeStatus | null | undefined): BadgeData | null | undefined {
	if (!s) return s;
	return {
		label: keyText(s.rank.name),
		value: text('Prestige {n}', { n: whole(s.value) }),
		title: s.next
			? text('Next: {rank} at {n} prestige (best so far {best})', {
					rank: keyText(s.next.name),
					n: whole(s.next.threshold),
					best: whole(s.best),
				})
			: text('The highest rank'),
	};
}
