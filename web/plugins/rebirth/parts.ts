// Rebirth in the browser (docs/design/gameplay.md §17.1): a hero card's stars, the rebirth pill's choice of heroes (from
// the heroes held here: one levelled up or sent off elsewhere shows or goes at once).
// Pure: the tests run it.
import type {
	FormPart,
	HeroCardPart,
	HeroesState,
	HeroInfo,
	RebirthCardData,
	RebirthFormData,
	RebirthRules,
} from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { defineClientPart } from '../../../src/shared/client-views';
import { iconVar, keyText, uiTexts } from '../../../src/shared/i18n';
import { realmText } from '../../../src/shared/rebirth';
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

/**
 * The heroes a rebirth pill may be used on now (as the server checks them): of the level, not reborn the most times yet,
 * free (not away), born with talents. From the heroes the browser holds, kept current by the commands.
 */
export function rebirthReady<H extends Pick<HeroInfo, 'id' | 'level' | 'duty' | 'talents'>>(
	heroes: H[],
	rule: RebirthRules & RebirthFormData['rebirth.heroes'],
	free: (duty: string) => boolean,
): H[] {
	return heroes.filter((h) => h.level >= rule.minLevel && (rule.counts[h.id] ?? 0) < rule.max && free(h.duty) && !!h.talents);
}

export const parts = [
	defineClientPart<HeroCardPart>({
		point: 'heroes.card',
		id: 'rebirth',
		part: (data) => {
			const d = data as RebirthCardData | undefined;
			if (!d?.count) return [];
			const s = stars(d.count, d.max).map((icon) => iconVar(icon));
			// The realm and the stars (user 2026-11-20: "转生后是练气修士，再转生升级为筑基").
			return [text('Realm: {0} {1}', { 0: realmText(d.count), 1: text('{0}{1}{2}{3}{4}', Object.fromEntries(s.map((v, i) => [i, v]))) })];
		},
	}),
	defineClientPart<FormPart<RebirthFormData['rebirth.heroes']>>({
		point: 'forms.prepare',
		id: 'rebirth.heroes',
		needs: ['heroes.list'],
		part: (d, { patch, data, meta, static: statics }) => {
			const list = data<Omit<HeroInfo, 'bonus'>[]>('heroes.list');
			const rules = statics<RebirthRules>('rebirth.rules');
			if (!list || !rules) return patch;
			const rule = { ...rules, ...d };
			const free = new Map((meta('heroes')?.duties ?? []).map((d) => [d.id, d.manual]));
			const ready = rebirthReady(list, rule, (duty) => !!free.get(duty));
			if (!ready.length) return false;
			return {
				...patch,
				options: {
					...patch.options,
					hero: ready.map((h) => ({
						value: h.id,
						label: text('{0} · Lv {1} · {2}', { 0: keyText(nameKey(h)), 1: h.level, 2: realmText(rule.counts[h.id] ?? 0) }) as UiText,
					})),
				},
			};
		},
	}),
];

/** A hero's stars after one more rebirth (its card data on the Heroes page; the first: as the rule's most). */
export function starred(s: HeroesState, hero: string, max: number): HeroesState {
	const h = s.heroes.find((x) => x.id === hero);
	if (!h) return s;
	const d = (h.parts?.rebirth as RebirthCardData | undefined) ?? { count: 0, max };
	return {
		...s,
		heroes: s.heroes.map((x) => (x.id === hero ? { ...x, parts: { ...x.parts, rebirth: { ...d, count: d.count + 1 } } } : x)),
	};
}
