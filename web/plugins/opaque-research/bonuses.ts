// What the player's opaque research gives now, each bonus once (wherever the GM put it, in however many groups): the
// thresholds passed in each group x each bonus's percent a step. The research page's block and the wall's upkeep (an
// extension point of starter-siege) both read it. Pure: the tests run it.
import type { OpaqueStatus, OpaqueTexts, SiegeUpkeepPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

export function bonusTotals(status: OpaqueStatus | null | undefined, texts: OpaqueTexts | undefined): Map<string, number> {
	const total = new Map<string, number>();
	(texts?.groups ?? []).forEach((parts, i) => {
		const steps = status?.steps[i] ?? 0;
		if (steps) for (const p of parts) total.set(p.bonus, (total.get(p.bonus) ?? 0) + steps * p.step);
	});
	return total;
}

// The starter content's words (the wall's upkeep cut is its bonus "defense-upkeep", by resource as "defense-upkeep:<id>").
const text = uiTexts('starter-opaque-research');
const DEFENSE_UPKEEP = 'defense-upkeep';

/**
 * The wall's upkeep cut by the Shuangqing Temple's research, by resource ("" = all), from what the browser holds (the
 * research page or the temple synced it): nothing until then (user 2026-11-05: "总览的地方加一行双清观科技效果的文字").
 */
const wallUpkeep: SiegeUpkeepPart = (get) => {
	const status = get.latest?.<OpaqueStatus | null>('opaque-research.status');
	const texts = get.static<OpaqueTexts>('opaque-research.texts');
	if (!status || !texts) return undefined;
	const percent: Record<string, number> = {};
	for (const [bonus, n] of bonusTotals(status, texts))
		if (n > 0 && (bonus === DEFENSE_UPKEEP || bonus.startsWith(`${DEFENSE_UPKEEP}:`))) percent[bonus.slice(DEFENSE_UPKEEP.length + 1)] = n;
	return Object.keys(percent).length ? { source: text('Shuangqing Temple research'), percent } : undefined;
};

export const parts = [
	defineClientPart<SiegeUpkeepPart>({ point: 'starter-siege.upkeep', id: 'starter-opaque-research', part: wallUpkeep }),
];
