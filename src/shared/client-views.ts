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
	compute(get: {
		data<D = unknown>(view: string): D | undefined;
		static<S = unknown>(id: string): S | undefined;
		meta<M = unknown>(key: string): M | undefined;
	}): T | undefined;
}

export const defineClientView = <T>(def: ClientViewDef<T>) => def;
