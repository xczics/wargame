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
}

export const defineClientView = <T>(def: ClientViewDef<T>) => def;
