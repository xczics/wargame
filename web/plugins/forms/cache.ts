// One request per (state, query): several form outlets showing the same placement (a global outlet on every
// page, kept alive) ask for the same forms after every sync. A new state starts afresh.
import type { ClientState } from '../../../src/shared/api';

let forState: unknown = null;
const pending = new Map<string, Promise<ClientState>>();

export function formsFor(state: unknown, query: string, fetch: () => Promise<ClientState>): Promise<ClientState> {
	if (state !== forState) {
		forState = state;
		pending.clear();
	}
	let p = pending.get(query);
	if (!p) {
		p = fetch();
		pending.set(query, p);
		// A failed request is not kept: the next outlet tries again.
		p.catch(() => pending.get(query) === p && pending.delete(query));
	}
	return p;
}
