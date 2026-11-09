// What a hero would give in each role, on its card (extension point "heroes.card" of the heroes client plugin), from
// the percents the starter-heroes plugin attaches to each hero. Pure: the tests run it.
import type { HeroRoleEffects } from '../../../src/shared/api';
import { uiTexts } from '../../../src/shared/i18n';
import { signed } from '../../../src/shared/format';
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

/**
 * A line per role; leading an army and defending give the same, so they show once as "military". `flats`: what the
 * hero adds to every lane in a battle role (user 2026-11-08: "理论上英雄的属性，都应该在前端某个地方能看得到"), after its %.
 */
export function roleLines(roles: HeroRoleEffects, flats: Record<string, Record<string, number>> = {}): UiText[] {
	const all: HeroRoleEffects = { ...roles };
	const lanes: Record<string, Record<string, number>> = { ...flats };
	const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
	if ((all.command || lanes.command) && same(all.command, all.defend) && same(lanes.command, lanes.defend)) {
		if (all.command) all.military = all.command;
		if (lanes.command) lanes.military = lanes.command;
		delete all.command;
		delete all.defend;
		delete lanes.command;
		delete lanes.defend;
	}
	const roleIds = [...new Set([...Object.keys(all), ...Object.keys(lanes)])];
	return roleIds
		.map(
			(role) =>
				[
					role,
					[
						...Object.entries(all[role] ?? {}).map(([effect, percent]) =>
							text('{effect} {value}', { effect: text(`effect:${effect}`), value: effectValue({ effect, percent }) }),
						),
						...Object.entries(lanes[role] ?? {}).map(([stat, n]) =>
							text('{effect} {value}', { effect: text(`lane:${stat}`), value: signed(n) }),
						),
					],
				] as const,
		)
		.filter(([, list]) => list.length)
		.map(([role, list]) => text('{0}: {1}', { 0: text(ROLE_NAMES[role] ?? role), 1: [...list] }));
}
