/**
 * The one measure of resources (user 2026-11-16: "统一一个资源价值。然后产量、资源卷、俸禄 统一用这个"): each resource's
 * value as its output says, vouchers priced by what they give is worth.
 */
import { describe, expect, it } from 'vitest';
import { csvNumber, csvRows, csvRules, engineContext } from '../../src/kernel';
import { type BuildingCatalog, levelEffects } from '../../src/shared/buildings';
import type { CardsData } from '../../src/shared/ui';
import offersCsv from '../../src/plugins/starter-shop/data/offers.csv?raw';
import usesCsv from '../../src/plugins/starter-items/data/uses.csv?raw';
import settlementRulesCsv from '../../src/plugins/player-settlements/data/rules.csv?raw';
import { db, defaultKernel } from '../helpers';

const ctx = engineContext(defaultKernel, 'x', 0);
const resources = defaultKernel.services.get('resources');

describe('resource values', () => {
	it('follow the output per slot, levels 1-20; a building one per district stands for its share of an outer city', async () => {
		const catalog = (
			(await defaultKernel.statics
				.find((x) => x.id === 'buildings.catalog')!
				.compute({ rules: { config: ctx.config }, db } as never)) as CardsData
		).data as BuildingCatalog;
		// An outer city's slots on average (player-settlements.outerSlots: min, mode, max), shared by the resource buildings.
		const slots = csvRules(settlementRulesCsv).outerSlots as { min: number; mode: number; max: number };
		const average = (slots.min + slots.mode + slots.max) / 3;
		const makers = Object.entries(catalog.buildings).filter(([, b]) => Object.keys(b.produces ?? {}).length === 1);
		const share = average / makers.length;
		const perSlot: Record<string, number> = {};
		for (const [, b] of makers) {
			const [r] = Object.keys(b.produces!);
			let sum = 0;
			for (let level = 1; level <= 20; level++) sum += levelEffects(b, level, 1).produces[r] ?? 0;
			perSlot[r] = b.unique === 'district' ? sum / share : sum;
		}
		for (const r of Object.keys(perSlot)) expect(resources.value(ctx, r), r).toBeCloseTo(perSlot.food / perSlot[r], 1);
	});

	it('vouchers give so much worth and cost by it: 250 a coupon (the tiers with their own discounts)', () => {
		const price = new Map(csvRows(offersCsv).map((o) => [o.item, csvNumber(o, 'price')]));
		for (const u of csvRows(usesCsv).filter((x) => x.id.endsWith('-voucher'))) {
			expect(u.effect, u.id).toBe('worth');
			expect(price.get(u.id), u.id).toBe(Math.round(csvNumber(u, 'amount') / 250));
		}
	});
});
