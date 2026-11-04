// The starter-auxiliary plugin's words for its units' hover on the Army page (extension point "troops.unitStats"): what
// each is for (user 2026-11-04: "骡车有啥载重？主要显示速度、容量呀"), from the static `starter-auxiliary.units`
// (role, a cart's seats, the surgeons' rules) and the units' numbers (speed, load). Pure: the tests run it.
import type { AuxiliaryUnits, UnitStatsPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { amount } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-auxiliary');

const words: UnitStatsPart = (unit, n, get) => {
	const what = get.static<AuxiliaryUnits>('starter-auxiliary.units')?.[unit];
	if (!what) return undefined;
	const speed = amount(n?.speed ?? 0);
	if (what.role === 'cart') return [text('Speed {0} tiles/h · carries {1} troops at its speed', { 0: speed, 1: amount(what.seats) })];
	if (what.role === 'medic')
		return [
			text('Speed {0} tiles/h · saves {1} of the fallen (at most {2}% of the losses)', {
				0: speed,
				1: amount(what.save),
				2: amount(what.cap * 100),
			}),
		];
	return [text('Speed {0} tiles/h · carries {1} supplies or loot', { 0: speed, 1: amount(n?.carry ?? 0) })];
};

// At the troops client plugin's extension point (its id is the server plugin whose units these are).
export const parts = [defineClientPart<UnitStatsPart>({ point: 'troops.unitStats', id: 'starter-auxiliary', part: words })];
