/** The assistant's equipment steward (gameplay.md §15): who wears what, in the group's order. Pure, no server. */
import { describe, expect, it } from 'vitest';
import { gain, numbersWith, outfit, type OutfitHero, type OutfitPiece } from '../../web/plugins/assistant/outfit';

const hero = (id: string, attrs: Record<string, number> = {}, level = 10, accessories = 1): OutfitHero => ({
	id,
	level,
	gender: 'm',
	attrs,
	accessories,
});
const piece = (
	id: string,
	slot: string,
	stats: Record<string, number>,
	hero: string | null = null,
	extra: Partial<OutfitPiece> = {},
): OutfitPiece => ({
	id,
	slot,
	minLevel: 1,
	stats,
	hero,
	...extra,
});

describe('assistant equipment steward', () => {
	it('adds what is worn to attributes and lane numbers', () => {
		const h = hero('a', { might: 10 });
		const n = numbersWith(h, [piece('s', 'weapon', { 'attr.might': 5, 'battle.attack': 30 })], {}, [
			{ target: 'attr:might' },
			{ target: 'flat:attack' },
		]);
		expect(n).toEqual({ 'attr:might': 15, 'flat:attack': 30 });
	});

	it('compares by how much each number grows, times its weight', () => {
		// +10 on 10 is +100%; +10 on 100 is +10%.
		expect(gain({ x: 10, y: 100 }, { x: 20, y: 110 }, [{ target: 'x' }, { target: 'y' }])).toBeCloseTo(1.1);
		expect(
			gain({ x: 10, y: 100 }, { x: 20, y: 110 }, [
				{ target: 'x', weight: 0 },
				{ target: 'y', weight: 2 },
			]),
		).toBeCloseTo(0.2);
	});

	it('the first hero picks first, from storage and from those after it; those after take what is left', () => {
		const heroes = [hero('a'), hero('b')];
		const pieces = [piece('big', 'weapon', { 'attr.might': 9 }, 'b'), piece('small', 'weapon', { 'attr.might': 3 })];
		const wants = () => [{ target: 'attr:might' }];
		expect(outfit(heroes, pieces, wants, {})).toEqual([
			{ piece: 'big', hero: 'a' },
			{ piece: 'small', hero: 'b' },
		]);
	});

	it('keeps what is better already, skips pieces above its level, and leaves heroes with no wants alone', () => {
		const pieces = [
			piece('worn', 'weapon', { 'attr.might': 5 }, 'a'),
			piece('weak', 'weapon', { 'attr.might': 2 }),
			piece('high', 'weapon', { 'attr.might': 50 }, null, { minLevel: 99 }),
			piece('kept', 'armor', { 'attr.wit': 1 }, 'b'),
		];
		expect(outfit([hero('a'), hero('b')], pieces, (id) => (id === 'a' ? [{ target: 'attr:might' }] : []), {})).toEqual([]);
	});

	it('a new accessory kind only while there is room', () => {
		const pieces = [
			piece('ring', 'ring', { 'attr.might': 3 }, 'a', { group: 'accessory' }),
			piece('amulet', 'amulet', { 'attr.might': 9 }, null, { group: 'accessory' }),
		];
		const wants = () => [{ target: 'attr:might' }];
		expect(outfit([hero('a', {}, 10, 1)], pieces, wants, {})).toEqual([]);
		expect(outfit([hero('a', {}, 10, 2)], pieces, wants, {})).toEqual([{ piece: 'amulet', hero: 'a' }]);
	});
});
