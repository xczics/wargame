/**
 * A hero's name as name-part keys ("s:Zhao m:Zilong"), which the client spells for the locale (surname first, no
 * space in Chinese): the one way to put a name in a text, on the server (`heroes.nameKey`) and in the browser alike.
 */
export const nameKey = (h: { surname: string; given: string }) => (h.given ? `${h.surname} ${h.given}` : h.surname);
