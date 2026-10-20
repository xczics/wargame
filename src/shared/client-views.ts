/**
 * A view assembled in the browser (AGENTS.md: the server sends data only, every display is made in the browser): the
 * data views it reads (under the request's parameters) and a pure function building what the widgets show from them
 * and the static views. The client plugin registers it (`game.clientView`); the tests run the same function on the
 * data views the engine works out (test/helpers.ts), so both go by one piece of code.
 */
export interface ClientViewDef<T = unknown> {
	id: string;
	needs: string[];
	/** `params`: the client's parameters the data views were asked with (e.g. the hero picked). */
	compute(get: {
		data<D = unknown>(view: string): D | undefined;
		static<S = unknown>(id: string): S | undefined;
		params: Readonly<Record<string, string>>;
	}): T | undefined;
}

export const defineClientView = <T>(def: ClientViewDef<T>) => def;
