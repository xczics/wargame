// The starter-defense plugin's lines on building cards, from the numbers its server plugin gives (`buildings.addEffects`):
// a wall's defence (with where its next percent step is), a hidden store's protection. Pure: the tests run it too.
import { amount } from '../../../src/shared/format';
import type { BuildingEffectPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';
import type { UiText } from '../../../src/shared/ui';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-defense');

const words: BuildingEffectPart = ({ level, values: v }) => {
	if (v.keeps !== undefined) return [text('Keeps {0} of every resource from raiders', { 0: amount(v.keeps) })];
	const out: UiText[] = [text('Defence +{0} in every lane', { 0: amount(v.defense ?? 0) })];
	if (v.percent) out.push(text('Defence +{0}%', { 0: v.percent }));
	// The next step as "★ Lv 10: Defence +5%" (as building and tech cards), none once at the cap.
	if (v.step > 0 && v.max > 0 && v.percent < v.max)
		out.push(
			text('★ Lv {0}: Defence +{1}% (+{2}% every {3} levels, at most +{4}%)', {
				0: (Math.floor(level / v.every) + 1) * v.every,
				1: Math.min(v.step, v.max - v.percent),
				2: v.step,
				3: v.every,
				4: v.max,
			}),
		);
	if (v.permanent > 0) out.push(text('Permanent defence +{0} in every lane (after every bonus)', { 0: amount(v.permanent) }));
	return out;
};

// At the buildings client plugin's extension point (its id is the server plugin whose numbers these are).
export const parts = [defineClientPart<BuildingEffectPart>({ point: 'buildings.effects', id: 'starter-defense', part: words })];
