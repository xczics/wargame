// The starter-siege plugin's line on the wall's card, from the number its server plugin gives (`buildings.addEffects`).
import type { BuildingEffectPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-siege');

const words: BuildingEffectPart = ({ values }) => [text('Siege works and defences built {0}% faster', { 0: values.faster ?? 0 })];

// At the buildings client plugin's extension point (its id is the server plugin whose numbers these are).
export const parts = [defineClientPart<BuildingEffectPart>({ point: 'buildings.effects', id: 'starter-siege', part: words })];
