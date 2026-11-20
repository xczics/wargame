// What commands did, told to the realms' overview held here (`realms.overview`) the way the server changes it. Pure:
// the tests run them; ./index.ts applies them with `game.patchView`.
import type { HeroInfo, RealmsOverview } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';

type HeroChange = Partial<Pick<HeroInfo, 'duty' | 'attrs' | 'level' | 'surname' | 'given'>>;

/** A hero as the overview has it after a change (free to set out = idle; its own attributes; its name key). */
export function heroChanged(o: RealmsOverview, id: string, change: HeroChange): RealmsOverview {
	if (!o.heroes.some((h) => h.id === id)) return o;
	return {
		...o,
		heroes: o.heroes.map((h) => {
			if (h.id !== id) return h;
			const [surname, given = ''] = h.name.split(' ');
			return {
				...h,
				...(change.duty !== undefined ? { idle: change.duty === 'idle' } : {}),
				...(change.attrs ? { attrs: change.attrs } : {}),
				...(change.level !== undefined ? { level: change.level } : {}),
				...(change.surname !== undefined || change.given !== undefined
					? { name: nameKey({ surname: change.surname ?? surname, given: change.given ?? given }) }
					: {}),
			};
		}),
	};
}

export const heroGone = (o: RealmsOverview, id: string): RealmsOverview =>
	o.heroes.some((h) => h.id === id) ? { ...o, heroes: o.heroes.filter((h) => h.id !== id) } : o;

/** Treatment started (`realms.heal`): it ends after its time, from now (the server's clock as the browser counts it). */
export function healing(o: RealmsOverview, hero: string, now: number): RealmsOverview {
	if (!o.injured.some((i) => i.hero === hero && i.healingUntil === null)) return o;
	return { ...o, injured: o.injured.map((i) => (i.hero === hero ? { ...i, healingUntil: now + i.seconds * 1000 } : i)) };
}
