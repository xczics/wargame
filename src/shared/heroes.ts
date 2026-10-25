import type { HeroAttributePart } from './api';
import type { ClientViewGet } from './client-views';

/**
 * A hero's name as name-part keys ("s:Zhao m:Zilong"), which the client spells for the locale (surname first, no
 * space in Chinese): the one way to put a name in a text, on the server (`heroes.nameKey`) and in the browser alike.
 */
export const nameKey = (h: { surname: string; given: string }) => (h.given ? `${h.surname} ${h.given}` : h.surname);

/**
 * A hero's attributes in the browser: its own plus what the client parts at "heroes.attributes" add (e.g. its gear),
 * as the server's `heroes.attributesOf` sums them.
 */
export function heroAttributes(hero: { id: string; attrs: Record<string, number> }, get: ClientViewGet): Record<string, number> {
	const out = { ...hero.attrs };
	for (const add of get.parts<HeroAttributePart>('heroes.attributes').values())
		for (const [a, n] of Object.entries(add(hero, get))) out[a] = (out[a] ?? 0) + n;
	return out;
}
