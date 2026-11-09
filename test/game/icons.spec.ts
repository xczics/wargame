/**
 * Icons in the widgets' data: icon ids (the drawn set) and art icons ("art:<scheme>:<key>|<fallback>"), the format, the
 * equipment's in every static, and every icon id the plugins use drawn by the starter icon set.
 */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import { equipmentIcon, parseEquipmentIcon } from '../../src/shared/equipment';
import { artIcon, fallbackIcon, ICON_SET, isIconId, parseIcon } from '../../src/shared/icons';
import { costVar } from '../../src/shared/i18n';
import { costPlain } from '../../src/shared/format';
import { iconImage, pixelPath } from '../../web/plugins/icons/image';
import { SPRITES as SPRITES_16 } from '../../web/plugins/starter-icons/sprites';
import { SPRITES_32 } from '../../web/plugins/starter-icons/sprites-32';

const SPRITES = { ...SPRITES_16, ...SPRITES_32 };
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
	it('reads back what it writes; an icon id is the drawn set, an art icon falls back to one', () => {
		const icon = artIcon('equipment', 'azure-edge/weapon/gold', 'sword');
		expect(icon).toBe('art:equipment:azure-edge/weapon/gold|sword');
		expect(parseIcon(icon)).toEqual({ scheme: 'equipment', key: 'azure-edge/weapon/gold', fallback: 'sword' });
		expect(fallbackIcon(icon)).toBe('sword');
		expect(parseIcon('wood')).toEqual({ scheme: ICON_SET, key: 'wood', fallback: '' });
		expect(fallbackIcon('wood')).toBe('wood');
		// A third party's older emoji: shown as it is.
		expect(parseIcon('\u{1FAB5}')).toBeNull();
		expect(isIconId('cart-horse')).toBe(true);
		expect(isIconId('Cart horse')).toBe(false);
		expect(() => artIcon('Bad Scheme', 'x')).toThrow();
		expect(parseEquipmentIcon(equipmentIcon({ slot: 'ring', rarity: 'blue' }))).toEqual({ slot: 'ring', rarity: 'blue' });
		expect(parseEquipmentIcon(equipmentIcon({ set: 'iron-guard', slot: 'helm', rarity: 'white' }, 'helm'))).toEqual({
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
		expect(fallbackIcon(azure.icon!)).toBe('sword');
		// Possible drops: a set in a colour by its first piece.
		const realms = all['realms.catalog'] as RealmsCatalog;
		const parts = realms.sections.flatMap((s) => s.rows.flatMap((r) => (r.lines ?? []).flatMap((l) => l.parts ?? [])));
		const set = parts.find((x) => x.text.text === 'starter-equipment.Azure Edge set')!;
		expect(parseEquipmentIcon(set.icon)).toMatchObject({ set: 'azure-edge', slot: 'weapon' });
		expect(fallbackIcon(set.icon!)).toBe('gift');
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
		const art = iconsIn(all).filter((i) => parseIcon(i)?.scheme === 'equipment');
		expect(art.length).toBeGreaterThan(50);
		for (const i of new Set(art)) {
			const p = parseEquipmentIcon(i);
			expect(p, i).not.toBeNull();
			expect(starterArt.piece(p!, 'm'), i).not.toBeNull();
		}
	});

	it('costs are data: drawn by icon, named where only text fits', () => {
		const resources = [
			{ id: 'wood', name: 'starter-content.Wood', icon: 'wood' },
			{ id: 'stone', name: 'starter-content.Stone', icon: 'stone' },
		];
		const v = costVar({ stone: 250, wood: 0, salt: 3 }, resources, { decimals: 1 });
		expect(v).toEqual({
			cost: [
				{ icon: 'stone', name: 'starter-content.Stone', amount: 250 },
				{ name: 'salt', amount: 3 },
			],
			decimals: 1,
		});
		expect(costPlain(v, (k) => k.replace('starter-content.', ''))).toBe('Stone 250, salt 3');
		// From icons only (a static view that sends just those).
		expect(costVar({ wood: 12_500 }, { wood: 'wood' }).cost).toEqual([{ icon: 'wood', name: 'wood', amount: 12_500 }]);
	});
});

describe('the starter icon set', () => {
	it('draws every icon id the plugins use: in the meta, the statics and the code', async () => {
		const used = new Set<string>();
		const add = (i: string | undefined) => {
			if (!i) return;
			const id = fallbackIcon(i);
			if (isIconId(id)) used.add(id);
		};
		for (const [id, provide] of defaultKernel.meta) if (id !== 'i18n' && id !== 'heroNames') iconsIn(await provide()).forEach(add);
		iconsIn(await statics()).forEach(add);
		// Ids written in the code: icon fields, icon vars, the widgets' <Icon icon="…">.
		const sources = import.meta.glob<string>('../../{src,web,examples}/**/*.{ts,vue,csv}', {
			query: '?raw',
			import: 'default',
			eager: true,
		});
		const literal = /(?:\bicon: |icon="|iconVar\(|withIcon\(|NO_ICON = |icon \?\? )['"]([a-z][a-z0-9-]*)['"]/g;
		for (const [file, text] of Object.entries(sources)) {
			if (file.includes('/starter-icons/') || file.endsWith('.spec.ts')) continue;
			for (const m of text.matchAll(literal)) if (!['string', 'undefined'].includes(m[1])) add(m[1]);
		}
		expect(used.size).toBeGreaterThan(80);
		const missing = [...used].filter((i) => !SPRITES[i]).sort();
		expect(missing).toEqual([]);
	});

	it('every sprite is 16 x 16 (32 x 32 for more detail), its letters coloured; it becomes a crisp SVG image', () => {
		for (const [id, art] of Object.entries(SPRITES)) {
			expect(isIconId(id), id).toBe(true);
			const side = id in SPRITES_32 ? 32 : 16;
			expect(art.rows.length, id).toBe(side);
			for (const row of art.rows) {
				expect(row.length, id).toBe(side);
				for (const c of row) if (c !== '.') expect(art.palette[c], `${id}: ${c}`).toMatch(/^#[0-9a-f]{6}$/i);
			}
		}
		expect(pixelPath(['.aa.', 'a..a'], 'a')).toBe('M1 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1z');
		const image = iconImage(SPRITES.wood)!;
		expect(image).toMatchObject({ w: 16, h: 16 });
		expect(decodeURIComponent(image.url)).toContain('shape-rendering="crispEdges"');
		expect(iconImage(SPRITES.wood)).toBe(image);
	});
});
