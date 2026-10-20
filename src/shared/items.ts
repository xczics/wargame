/**
 * Other plugins' groups on the Items page (`items.addCards`): the server sends their data (view `items.extra`, by
 * source), and a builder registered here for the source assembles the group and its cards in the browser. The client
 * plugin showing that system registers it; the tests register the same ones (test/helpers.ts). Pure functions.
 */
import type { UiCard, UiText } from './ui';

export type ItemCardsBuilder = (data: unknown) => { group: { id: string; label: UiText }; cards: UiCard[] } | null;

const builders = new Map<string, ItemCardsBuilder>();

export function defineItemCards(source: string, build: ItemCardsBuilder) {
	builders.set(source, build);
}

export const itemCardsOf = (source: string) => builders.get(source);
