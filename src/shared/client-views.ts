import type { Meta } from './api';

/**
 * A view assembled in the browser (AGENTS.md: the server sends data only, every display is made in the browser): the
 * data views it reads (under the request's parameters) and a pure function building what the widgets show from them,
 * the static views and the meta (names and icons of content, sent once). The client plugin registers it
 * (`game.clientView`); the tests run the same function on the data views the engine works out (test/helpers.ts), so
 * both go by one piece of code.
 */
export interface ClientViewDef<T = unknown> {
	id: string;
	needs: string[];
	/** The extension points whose parts it runs: what those parts need is fetched with it (`viewNeeds`). */
	points?: string[];
	compute(get: ClientViewGet): T | undefined;
}

/**
 * What a client view reads: the data views it needs, the static views, the client's parameters the data views were
 * asked with (e.g. the hero picked), and the meta (names, icons, the map's size).
 */
export interface ClientViewGet {
	data<D = unknown>(view: string): D | undefined;
	static<S = unknown>(id: string): S | undefined;
	params: Readonly<Record<string, string>>;
	/** A declared meta key typed as declared; another one (a plugin's own, e.g. "armyMissions") as asked. */
	meta<K extends keyof Meta>(key: K): Meta[K] | undefined;
	meta<M>(key: string): M | undefined;
	/**
	 * What other client plugins add at an extension point of this view's plugin (`defineClientPart`), by the id of the
	 * server plugin whose data each renders (e.g. at "heroes.card": "realms" renders what the realms plugin attached).
	 */
	parts<P>(point: string): ReadonlyMap<string, P>;
}

export const defineClientView = <T>(def: ClientViewDef<T>) => def;

/**
 * A client plugin's share of a display another client plugin assembles (one plugin, one system: the owner does not
 * know what others add). The owner names and types an extension point (e.g. "heroes.card", src/shared/api.ts) and
 * hands each part the data the server plugin `id` attached for it (e.g. a hero's `parts[id]`); the part renders its
 * own words. Registered with `game.clientPart` and listed in web/views.ts (the tests run them too).
 */
export interface ClientPartDef<P = unknown> {
	point: string;
	/** The server plugin whose data it renders (the key the owner's data view files it under). */
	id: string;
	part: P;
	/** Data views it reads itself (`get.data`), fetched wherever a view running it is shown. */
	needs?: string[];
	/** Extension points it runs the parts of in turn (their needs count too). */
	points?: string[];
}

export const defineClientPart = <P>(def: ClientPartDef<P>) => def;

/** The data views a client view reads: its own, and those of the parts it runs (at its points, and theirs). */
export function viewNeeds(def: Pick<ClientViewDef, 'needs' | 'points'>, all: readonly ClientPartDef[]): string[] {
	const out = new Set(def.needs);
	const seen = new Set<string>();
	const visit = (points: readonly string[] = []) => {
		for (const point of points) {
			if (seen.has(point)) continue;
			seen.add(point);
			for (const p of all.filter((d) => d.point === point)) {
				for (const n of p.needs ?? []) out.add(n);
				visit(p.points);
			}
		}
	};
	visit(def.points);
	return [...out];
}

/** The parts registered at `point`, by id (what `ClientViewGet.parts` answers). */
export const partsAt = <P>(all: readonly ClientPartDef[], point: string): ReadonlyMap<string, P> =>
	new Map(all.filter((d) => d.point === point).map((d) => [d.id, d.part as P]));
