// The starter equipment's art pack for the paper doll: two figures and a sprite per (set x slot x figure), recoloured
// by rarity. Replacing the art = editing ./sprites.ts (rows) and ./palette.ts (colours). Pure: the tests run it.
import type { DollArt } from '../../equipment/art';
import { FIGURE_PALETTES, gearPalette } from './palette';
import { FIGURES, PIECES } from './sprites';

// Frames: weapon and trinket by the right hand / belt side, helm, armour and boots down the other.
const SIDES: Record<string, 'left' | 'right'> = { helm: 'left', armour: 'left', boots: 'left', weapon: 'right', charm: 'right' };
// Drawing order on the figure.
const Z: Record<string, number> = { boots: 1, armour: 2, 'acc-shawl': 3, charm: 4, helm: 6, weapon: 7, 'acc-fan': 7 };

export const starterArt: DollArt = {
	size: [48, 96],
	figure: (gender) => ({ sprite: FIGURES[gender], palette: FIGURE_PALETTES[gender] }),
	piece(p, gender) {
		// Accessories are drawn on the heroine only.
		const on = PIECES[`${p.set}/${p.slot}/${gender}`] ? gender : 'f';
		const art = PIECES[`${p.set}/${p.slot}/${on}`];
		if (!art) return null;
		const palette = gearPalette(p.set, p.rarity);
		return {
			front: { sprite: art.front, palette },
			...(art.back ? { back: { sprite: art.back, palette } } : {}),
			icon: art.icon,
			...(art.onFigure ? { iconFigure: on } : {}),
			z: Z[p.slot] ?? 5,
		};
	},
	side: (slot) => SIDES[slot],
};
