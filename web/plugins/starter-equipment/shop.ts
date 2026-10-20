// The realm shop's player part (`starter-equipment.shop-rows`, generic `ui.rows` over the static
// `starter-equipment.shop-catalog`), assembled in the browser (AGENTS.md: the server sends data only) from which realms
// the player has opened (`realms.overview`). Pure: the tests run it.
import type { RealmsOverview } from '../../../src/shared/api';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { RowsData } from '../../../src/shared/ui';

// The starter-equipment plugin's own words (its i18n keys).
const text = uiTexts('starter-equipment');

export function shopRows(o: RealmsOverview | undefined): RowsData | null | undefined {
	if (!o) return undefined;
	const open = o.realms.filter((r) => r.unlocked);
	if (!open.length) return null;
	return {
		base: 'starter-equipment.shop-catalog',
		// The newest open realm by default (the realms page on the right follows the same choice).
		defaultTab: open.reduce((a, b) => (b.order > a.order ? b : a)).id,
		counters: Object.fromEntries(open.map((r) => [`realm:${r.id}`, 1])),
		sections: o.realms.map((r) => ({
			group: r.id,
			allRows: true,
			rows: [],
			...(r.unlocked ? {} : { title: text('{0} 🔒', { 0: keyText(r.name) }) }),
		})),
	};
}
