/** The equipment screen's paper doll in the browser: the pixel composition, the frames' places, and the starter art pack. */
import { describe, expect, it } from 'vitest';
import setsCsv from '../../src/plugins/starter-equipment/data/sets.csv?raw';
import slotsCsv from '../../src/plugins/starter-equipment/data/slots.csv?raw';
import { csvRows } from '../../src/kernel';
import { dollLayers, slotColumns } from '../../web/plugins/equipment/art';
import { compose, fitScale, type PixelLayer } from '../../web/plugins/equipment/pixels';
import { starterArt } from '../../web/plugins/starter-equipment/art';
import { FIGURE_PALETTES, gearPalette } from '../../web/plugins/starter-equipment/art/palette';
import { FIGURES, PIECES } from '../../web/plugins/starter-equipment/art/sprites';

const sets = csvRows(setsCsv);
const slots = csvRows(slotsCsv);

describe('paper doll', () => {
	it('composes pixel layers into RGBA in order, cropped to a box; unknown letters stay transparent', () => {
		const a: PixelLayer = { sprite: { x: 1, y: 0, rows: ['ab', '.a'] }, palette: { a: '#ff0000', b: '#00ff00' } };
		const b: PixelLayer = { sprite: { x: 2, y: 1, rows: ['c', 'c'] }, palette: { c: '#0000ff' } };
		const px = compose([a, b], [1, 0, 2, 2]);
		const at = (x: number, y: number) => [...px.slice((y * 2 + x) * 4, (y * 2 + x) * 4 + 4)];
		expect(at(0, 0)).toEqual([255, 0, 0, 255]);
		expect(at(1, 0)).toEqual([0, 255, 0, 255]);
		expect(at(0, 1)).toEqual([0, 0, 0, 0]); // "."
		expect(at(1, 1)).toEqual([0, 0, 255, 255]); // the later layer over the earlier
		expect(fitScale([0, 0, 12, 20], 40)).toBe(2);
		expect(fitScale([0, 0, 60, 20], 40)).toBe(1);
	});

	it('places the frames on the sides the art names, the rest shared out, and draws capes behind the figure', () => {
		const ids = ['weapon', 'helm', 'armour', 'boots', 'charm', 'other'].map((id) => ({ id }));
		const { left, right } = slotColumns(ids, starterArt.side);
		expect(left.map((s) => s.id)).toEqual(['helm', 'armour', 'boots']);
		expect(right.map((s) => s.id)).toEqual(['weapon', 'charm', 'other']);
		const fig = starterArt.figure('m');
		const armour = starterArt.piece({ slot: 'armour', set: 'heavens-plan', rarity: 'gold' }, 'm')!;
		const weapon = starterArt.piece({ slot: 'weapon', set: 'heavens-plan', rarity: 'gold' }, 'm')!;
		const layers = dollLayers(fig, [weapon, armour, null]);
		expect(layers).toEqual([armour.back, fig, armour.front, weapon.front]);
	});

	it('has a sprite for every regular set and slot on both figures, and every accessory set and kind on the heroine', () => {
		const regular = sets.filter((s) => s.kind === 'regular').map((s) => s.id);
		const accessory = sets.filter((s) => s.kind === 'accessory').map((s) => s.id);
		expect(regular).toHaveLength(7);
		expect(accessory).toHaveLength(4);
		for (const set of regular)
			for (const slot of slots.filter((x) => !x.group))
				for (const g of ['m', 'f'] as const)
					expect(starterArt.piece({ slot: slot.id, set, rarity: 'blue' }, g), `${set}/${slot.id}/${g}`).not.toBeNull();
		for (const set of accessory)
			for (const slot of slots.filter((x) => x.group === 'accessory'))
				expect(starterArt.piece({ slot: slot.id, set, rarity: 'blue' }, 'f'), `${set}/${slot.id}`).toMatchObject({ iconFigure: 'f' });
		// Sets are told apart by their drawing, not only their colour.
		const drawn = (set: string, slot: string) => PIECES[`${set}/${slot}/m`].front.rows.join('\n');
		for (const slot of ['weapon', 'helm', 'armour', 'boots', 'charm']) expect(new Set(regular.map((s) => drawn(s, slot))).size).toBe(7);
	});

	it('keeps every sprite on the grid with a colour for each of its letters', () => {
		const [w, h] = starterArt.size;
		const check = (name: string, s: { x: number; y: number; rows: string[] }, palette: Record<string, string>) => {
			expect(s.x >= 0 && s.y >= 0 && s.x + s.rows[0].length <= w && s.y + s.rows.length <= h, name).toBe(true);
			expect(new Set(s.rows.map((r) => r.length)).size, name).toBe(1);
			for (const ch of new Set(s.rows.join(''))) if (ch !== '.') expect(palette[ch], `${name}: "${ch}"`).toMatch(/^#[0-9a-f]{6}$/);
		};
		for (const g of ['m', 'f'] as const) check(`figure ${g}`, FIGURES[g], FIGURE_PALETTES[g]);
		for (const [key, p] of Object.entries(PIECES)) {
			const palette = gearPalette(key.split('/')[0], 'purple');
			check(key, p.front, palette);
			if (p.back) check(`${key} back`, p.back, palette);
			const [x, y, iw, ih] = p.icon;
			expect(iw > 0 && ih > 0 && x + iw > 0 && y + ih > 0, key).toBe(true);
		}
	});
});
