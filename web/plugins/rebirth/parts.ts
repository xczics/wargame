// Rebirth in the browser (docs/design/gameplay.md §17.1): a hero card's stars, the rebirth pill's choice of heroes.
// Pure: the tests run it.
import type { FormPart, HeroCardPart, RebirthCardData, RebirthFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { iconVar, keyText, uiTexts } from '../../../src/shared/i18n';
import type { UiText } from '../../../src/shared/ui';

// The rebirth plugin's words (its i18n keys).
const text = uiTexts('rebirth');

/**
 * Five stars for nine rebirths (user 2026-11-16: "一到八转每转亮半颗（八转是四颗），九转一次点亮最后一整颗，表示'圆满'"):
 * the icons of each star, lit, half lit or dim.
 */
export function stars(count: number, max = 9): string[] {
	const halves = count >= max ? 10 : Math.min(8, count);
	return Array.from({ length: 5 }, (_, i) => (halves >= 2 * i + 2 ? 'star' : halves === 2 * i + 1 ? 'star-half' : 'star-dim'));
}

export const parts = [
	defineClientPart<HeroCardPart>({
		point: 'heroes.card',
		id: 'rebirth',
		part: (data) => {
			const d = data as RebirthCardData | undefined;
			if (!d?.count) return [];
			const s = stars(d.count, d.max).map((icon) => iconVar(icon));
			return [text('Rebirth: {0}', { 0: text('{0}{1}{2}{3}{4}', Object.fromEntries(s.map((v, i) => [i, v]))) })];
		},
	}),
	defineClientPart<FormPart<RebirthFormData['rebirth.heroes']>>({
		point: 'forms.prepare',
		id: 'rebirth.heroes',
		part: (list, { patch }) => ({
			...patch,
			options: {
				...patch.options,
				hero: list.map((h) => ({
					value: h.id,
					label: text('{0} · Lv {1} · reborn {2}', { 0: keyText(h.name), 1: h.level, 2: h.count }) as UiText,
				})),
			},
		}),
	}),
];
