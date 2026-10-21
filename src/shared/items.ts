/**
 * Other plugins' groups on the Items page (`items.addCards`): the server sends their data (view `items.extra`, by
 * source), and a builder registered here for the source assembles the group and its cards in the browser. The client
 * plugin showing that system registers it; the tests register the same ones (test/helpers.ts). Pure functions.
 */
import type { OddsData } from './api';
import { uiTexts } from './i18n';
import type { UiCard, UiText } from './ui';

// The items plugin's words (its i18n keys).
const text = uiTexts('items');

/** "50% · pity 1/2": the chance when it is given (to the GM), the pity count when there is one; null: nothing to say. */
export function oddsText(o: OddsData): UiText | null {
	const pct = o.chance === undefined ? undefined : Math.round(o.chance * 100);
	if (pct !== undefined && o.pity) return text('{0}% · pity {1}/{2}', { 0: pct, 1: o.fails, 2: o.pity });
	if (pct !== undefined) return text('{0}%', { 0: pct });
	return o.pity ? text('pity {0}/{1}', { 0: o.fails, 1: o.pity }) : null;
}

export type ItemCardsBuilder = (data: unknown) => { group: { id: string; label: UiText }; cards: UiCard[] } | null;

const builders = new Map<string, ItemCardsBuilder>();

export function defineItemCards(source: string, build: ItemCardsBuilder) {
	builders.set(source, build);
}

export const itemCardsOf = (source: string) => builders.get(source);
