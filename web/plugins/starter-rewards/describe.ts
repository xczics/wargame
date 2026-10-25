// The starter kinds of rewards in a few words (a GM's mail's attachments): parts at "rewards.describe" by kind, from the
// reward's config and the names in the meta (the server sends the rewards as stored). Pure: the tests run them.
import type { Meta, RewardPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { amount, whole } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The starter-rewards plugin's own words (its i18n keys).
const text = uiTexts('starter-rewards');

const named = (list: readonly { id: string; name: string }[] | undefined, id: string) =>
	keyText(list?.find((x) => x.id === id)?.name ?? id);

export const parts = [
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'resources',
		part: (c, get) =>
			text('{0}', {
				0: Object.entries(c as Record<string, number>).map(([id, n]) =>
					text('{0} ×{1}', { 0: named(get.meta<Meta['resources']>('resources'), id), 1: amount(n) }),
				),
			}),
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'item',
		part: (c, get) => {
			const { item, count } = c as { item: string; count: number };
			return text('{0} ×{1}', { 0: named(get.meta<Meta['items']>('items'), item), 1: amount(count) });
		},
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'coupons',
		part: (c) => text('{0} yuanbao', { 0: whole((c as { amount: number }).amount) }),
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'troops',
		part: (c, get) => {
			const { unit, count } = c as { unit: string; count: number };
			return text('{0} ×{1}', { 0: named(get.meta<Meta['units']>('units'), unit), 1: amount(count) });
		},
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'equipment',
		part: (c, get) => {
			const { set, rarity, piece } = c as { set: string; rarity: string; piece: string | null };
			const meta = get.meta<Meta['equipment']>('equipment');
			const setName = meta?.bases.find((b) => b.set?.id === set)?.set?.name ?? set;
			return text('{0} {1}', {
				0: named(meta?.rarities, rarity),
				1: keyText((piece ? meta?.bases.find((b) => b.id === piece)?.name : undefined) ?? setName),
			});
		},
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'defense',
		part: (c) => text('Permanent defence +{0} in every lane of a settlement you choose', { 0: amount((c as { amount: number }).amount) }),
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'hero-female',
		part: (c, get) =>
			text('A heroine, recruited like at {0}', { 0: named(get.meta<Meta['heroes']>('heroes')?.venues, (c as { venue: string }).venue) }),
	}),
	defineClientPart<RewardPart>({
		point: 'rewards.describe',
		id: 'hero',
		part: (c, get) =>
			text('A hero of the GM, recruited like at {0}', {
				0: named(get.meta<Meta['heroes']>('heroes')?.venues, (c as { venue: string }).venue),
			}),
	}),
];
