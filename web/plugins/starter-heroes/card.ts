// What a hero would give in each role, on its card (extension point "heroes.card" of the heroes client plugin), from
// the percents the starter-heroes plugin attaches to each hero. Pure: the tests run it.
import type { HeroRoleEffects } from '../../../src/shared/api';
import { uiTexts } from '../../../src/shared/i18n';
import { effectValue } from '../../../src/shared/starter-heroes';
import type { UiText } from '../../../src/shared/ui';

// The starter-heroes plugin's own words (its i18n keys): the lines read as they did when the server built them.
const text = uiTexts('starter-heroes');

const ROLE_NAMES: Record<string, string> = {
	governor: 'Governor',
	scholar: 'Institute post',
	command: 'Leading an army',
	defend: 'Defending',
	military: 'Military bonus',
};

/** A line per role; leading an army and defending give the same, so they show once as "military". */
export function roleLines(roles: HeroRoleEffects): UiText[] {
	const all: HeroRoleEffects = { ...roles };
	if (all.command && JSON.stringify(all.command) === JSON.stringify(all.defend)) {
		all.military = all.command;
		delete all.command;
		delete all.defend;
	}
	return Object.entries(all)
		.filter(([, list]) => Object.keys(list).length)
		.map(([role, list]) =>
			text('{0}: {1}', {
				0: text(ROLE_NAMES[role] ?? role),
				1: Object.entries(list).map(([effect, percent]) =>
					text('{effect} {value}', { effect: text(`effect:${effect}`), value: effectValue({ effect, percent }) }),
				),
			}),
		);
}
