// NPC heroes' specs (the npc-heroes plugin makes them): "tavern/3/45", a hero of the tavern, recruited at its level 3,
// now level 45. Shared: content tables (a trade route's generals) are parsed where the server and the tests read them.

export interface NpcHeroSpec {
	venue: string;
	venueLevel: number;
	level: number;
}

/** A made NPC hero: its spec, attributes, name (keys, as a hero's) and how it spent its free points (a text key). */
export interface NpcHero extends NpcHeroSpec {
	attrs: Record<string, number>;
	surname?: string;
	given?: string;
	build?: string;
}

/** A spec from "<venue>/<venue level>/<level>" (`bad` makes the error), or null for an empty cell. */
export function parseNpcHeroSpec(cell: string, bad: (msg: string) => Error): NpcHeroSpec | null {
	const raw = cell.trim();
	if (!raw) return null;
	const [venue, venueLevel, level] = raw.split('/').map((x) => x.trim());
	const spec = { venue, venueLevel: Number(venueLevel), level: Number(level) };
	if (!venue || !Number.isInteger(spec.venueLevel) || spec.venueLevel < 1 || !Number.isInteger(spec.level) || spec.level < 1)
		throw bad(`"${raw}": a general is "<venue>/<venue level>/<level>", e.g. "tavern/3/45"`);
	return spec;
}
