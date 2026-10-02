/**
 * Texts sent to the client are i18n keys "<pluginId>.<key>" (src/plugins/i18n). These map every text of a
 * structure to such keys: both ends use them (a hook's results on the server, a view's texts on the client).
 */

/** Map the text and string vars of every UiText ({ text, vars? }) in `value`, in place. Returns `value`. */
export function mapUiTexts<T>(value: T, map: (text: string) => string): T {
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== 'object') return;
		const o = v as Record<string, unknown>;
		if (typeof o.text === 'string' && Object.keys(o).every((k) => k === 'text' || k === 'vars')) {
			o.text = map(o.text);
			if (o.vars && typeof o.vars === 'object')
				for (const [k, x] of Object.entries(o.vars as Record<string, unknown>)) {
					if (typeof x === 'string') (o.vars as Record<string, unknown>)[k] = map(x);
					else walk(x);
				}
			return;
		}
		Object.values(o).forEach(walk);
	};
	walk(value);
	return value;
}

/**
 * Whether a text has nothing to translate: placeholders, numbers, durations ("1m 30s"), rates ("+1/s") and
 * people's names (name-part keys "s:Wang m:Rui", spelled by the client). No plugin's: never prefixed.
 */
export function neutral(text: string): boolean {
	const rest = text
		.replace(/\{\w+\}/g, '')
		.replace(/\bs:[^\s,，]+ [mf]:[^\s,，]+/g, '')
		.replace(/\b\d+(\.\d+)?[dhms]\b/g, '')
		.replace(/\/[smh]\b/g, '');
	return !/\p{L}/u.test(rest);
}

/**
 * Whether a text is translatable as it is: a registered key ("starter-content.Farm") or a full match of a
 * pattern key ("starter-realms.Key to {0}" for "starter-realms.Key to Black Wind Ridge"). Anything else
 * (a text built around a key, a plain text) still needs the prefix of the plugin it belongs to. Texts
 * without letters count too: there is nothing to translate.
 */
export function keyMatcher(keys: Iterable<string>): (text: string) => boolean {
	const exact = new Set<string>();
	const patterns = new Map<string, RegExp[]>(); // by plugin id (ids have no dots)
	for (const key of keys) {
		if (!/\{\d+\}/.test(key)) {
			exact.add(key);
			continue;
		}
		const dot = key.indexOf('.');
		if (dot < 0) continue;
		const source = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d+\\\}/g, '(.+?)');
		const list = patterns.get(key.slice(0, dot)) ?? [];
		list.push(new RegExp(`^${source}$`, 's'));
		patterns.set(key.slice(0, dot), list);
	}
	return (text) => {
		if (exact.has(text) || neutral(text)) return true;
		const dot = text.indexOf('.');
		return dot > 0 && !!patterns.get(text.slice(0, dot))?.some((re) => re.test(text));
	};
}

/**
 * The translation tables of both ends: exact texts and pattern keys ("Requires {0} Lv {1}") per locale.
 * `lookup` gives a text in a locale, or undefined; how a pattern's captures are translated is up to the
 * caller (`capture`, given the pattern's plugin id: the client tries "<id>.<capture>" first, then anything;
 * undefined = no translation, and `fallback` shows such a part; without `fallback` only a text whose parts
 * all translate counts).
 *
 * A text may split more than one way ("{0} ({1})" on "Bowmen (Archers) Levy Order (2)", "{0} {1} chest" on
 * "rarity:gold Azure Edge set chest"): each pattern is tried with its parts as short and as long as they go,
 * and the first split whose parts all translate wins.
 */
export function createCatalog() {
	const exact = new Map<string, Map<string, string>>(); // locale -> key -> text
	const patterns = new Map<string, { splits: RegExp[]; to: string; fixed: number; ns: string | null }[]>();
	let namespaces = new Set<string>();
	return {
		add(loc: string, messages: Record<string, string>) {
			if (!exact.has(loc)) exact.set(loc, new Map());
			if (!patterns.has(loc)) patterns.set(loc, []);
			for (const [from, to] of Object.entries(messages)) {
				if (/\{\d+\}/.test(from)) {
					const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const splits = ['(.+?)', '(.+)'].map((part) => new RegExp(`^${escaped.replace(/\\\{\d+\\\}/g, part)}$`, 's'));
					const dot = from.indexOf('.');
					const ns = dot > 0 ? from.slice(0, dot) : null;
					patterns.get(loc)!.push({ splits, to, fixed: from.replace(/\{\d+\}/g, '').length, ns });
				} else {
					exact.get(loc)!.set(from, to);
				}
			}
			// Most specific first (the most fixed text), whichever plugin added it: "City limit {0}/{1} · pity {2}/{3}"
			// before "City limit {0}/{1}", so a looser key never swallows a message meant for a longer one.
			patterns.get(loc)!.sort((a, b) => b.fixed - a.fixed);
		},
		/** Plugin ids: a pattern key's prefix counts as its plugin only when it is one of these. */
		setNamespaces(ids: Iterable<string>) {
			namespaces = new Set(ids);
		},
		has: (text: string, loc: string) => exact.get(loc)?.has(text) ?? false,
		lookup(
			text: string,
			loc: string,
			capture: (part: string, ns: string | null) => string | undefined,
			fallback?: (part: string) => string,
		): string | undefined {
			const found = exact.get(loc)?.get(text);
			if (found !== undefined) return found;
			let first: (() => string) | null = null;
			for (const { splits, to, ns } of patterns.get(loc) ?? []) {
				// A client plugin's ('@<id>') or a server plugin's.
				const plugin = ns && (ns.startsWith('@') || namespaces.has(ns)) ? ns : null;
				for (const re of splits) {
					const m = re.exec(text);
					if (!m) continue;
					const parts = m.slice(1).map((part) => ({ part, to: capture(part, plugin) }));
					const fill = () => to.replace(/\{(\d+)\}/g, (_, i) => parts[Number(i)]?.to ?? fallback!(parts[Number(i)]?.part ?? ''));
					if (parts.every((p) => p.to !== undefined)) return fill();
					if (fallback) first ??= fill;
				}
			}
			return first?.();
		},
		locales: () => [...exact.keys()],
	};
}
