/** Art icons in the widgets' data ("art:<scheme>:<key>|<fallback>"): the format, and the equipment's in every static. */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import { equipmentIcon, parseEquipmentIcon } from '../../src/shared/equipment';
import { artIcon, parseIcon, plainIcon } from '../../src/shared/icons';
import type { CardsData, RowsData } from '../../src/shared/ui';
import type { ItemCatalog, RealmsCatalog } from '../../src/shared/api';
import { starterArt } from '../../web/plugins/starter-equipment/art';
import { db, defaultKernel } from '../helpers';

const statics = async () => {
	const out: Record<string, unknown> = {};
	const config = engineContext(defaultKernel, 'x', 0).config;
	for (const def of defaultKernel.statics) out[def.id] = await def.compute({ rules: { config }, db } as never);
	return out;
};
/** Every icon string anywhere in a value. */
const iconsIn = (x: unknown, out: string[] = []): string[] => {
	if (Array.isArray(x)) for (const v of x) iconsIn(v, out);
	else if (x && typeof x === 'object')
		for (const [k, v] of Object.entries(x)) {
			if (k === 'icon' && typeof v === 'string') out.push(v);
			else iconsIn(v, out);
		}
	return out;
};

describe('art icons', () => {
	it('reads back what it writes; text-only places get the fallback emoji', () => {
		const icon = artIcon('equipment', 'azure-edge/weapon/gold', '🗡️');
		expect(icon).toBe('art:equipment:azure-edge/weapon/gold|🗡️');
		expect(parseIcon(icon)).toEqual({ scheme: 'equipment', key: 'azure-edge/weapon/gold', fallback: '🗡️' });
		expect(plainIcon(icon)).toBe('🗡️');
		expect(plainIcon('🪵')).toBe('🪵');
		expect(plainIcon(undefined)).toBe('');
		expect(parseIcon('🪵')).toBeNull();
		expect(() => artIcon('Bad Scheme', 'x')).toThrow();
		expect(parseEquipmentIcon(equipmentIcon({ slot: 'ring', rarity: 'blue' }))).toEqual({ slot: 'ring', rarity: 'blue' });
		expect(parseEquipmentIcon(equipmentIcon({ set: 'iron-guard', slot: 'helm', rarity: 'white' }, '⛑️'))).toEqual({
			set: 'iron-guard',
			slot: 'helm',
			rarity: 'white',
		});
	});

	it('shows equipment by its art in the realm shop, the drop lists and the chests, each one the starter art draws', async () => {
		const all = await statics();
		const shop = all['starter-equipment.shop-catalog'] as RowsData;
		const azure = shop.sections[0].rows.find((r) => r.id === 'azure-edge-weapon')!;
		expect(parseEquipmentIcon(azure.icon)).toEqual({ set: 'azure-edge', slot: 'weapon', rarity: 'white' });
		expect(plainIcon(azure.icon)).toBe('🗡️');
		// Possible drops: a set in a colour by its first piece.
		const realms = all['realms.catalog'] as RealmsCatalog;
		const parts = realms.sections.flatMap((s) => s.rows.flatMap((r) => (r.lines ?? []).flatMap((l) => l.parts ?? [])));
		const set = parts.find((x) => x.text.text === 'starter-equipment.Azure Edge set')!;
		expect(parseEquipmentIcon(set.icon)).toMatchObject({ set: 'azure-edge', slot: 'weapon' });
		expect(plainIcon(set.icon)).toBe('🎁');
		const accessory = parts.find((x) => x.text.text === 'starter-equipment.Accessory')!;
		expect(parseEquipmentIcon(accessory.icon)).toMatchObject({ rarity: accessory.rarity });
		// The words carry no icon (it is the part's own field).
		expect(set.text.vars).toBeUndefined();
		const chests = (all['items.catalog'] as ItemCatalog).items.filter((i) => i.category === 'chests');
		expect(chests.length).toBeGreaterThan(0);
		for (const c of chests) expect(parseEquipmentIcon(c.icon), c.id).toMatchObject({ rarity: c.rarity });
		const offers = all['shop.offers'] as CardsData;
		expect(offers.cards.some((c) => parseEquipmentIcon(c.icon))).toBe(true);
		// Every equipment icon in any static is one the starter art pack draws.
		const art = iconsIn(all).filter((i) => parseIcon(i));
		expect(art.length).toBeGreaterThan(50);
		for (const i of new Set(art)) {
			const p = parseEquipmentIcon(i);
			expect(p, i).not.toBeNull();
			expect(starterArt.piece(p!, 'm'), i).not.toBeNull();
		}
	});
});
