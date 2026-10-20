// The Shuangqing Temple's lines on its card, from the numbers the server plugin gives (`buildings.addEffects`): projects
// at a time, the highest tier it approves (0: none yet).
import type { BuildingEffectPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';
import type { UiText } from '../../../src/shared/ui';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-opaque-research');

const words: BuildingEffectPart = ({ values }) => {
	const out: UiText[] = [text('Projects at a time: {0}', { 0: values.projects ?? 0 })];
	if (values.tier) out.push(text('Approves up to: {0}', { 0: text(`tier:${values.tier}`) }));
	return out;
};

// At the buildings client plugin's extension point (its id is the server plugin whose numbers these are).
export const parts = [defineClientPart<BuildingEffectPart>({ point: 'buildings.effects', id: 'starter-opaque-research', part: words })];
