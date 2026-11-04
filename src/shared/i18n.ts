/**
 * Texts sent to the client are UiTexts whose `text` is a full i18n key "<pluginId>.<key>" (src/plugins/i18n).
 * Their vars are values (numbers, amounts, names a player typed, heroes' name-part keys) or texts themselves:
 * the client translates the key and the vars that are UiTexts, nothing else.
 */
import type { UiCostVar, UiIconVar, UiText, UiVar } from './ui';

/**
 * A plugin's texts: `const text = uiTexts('<pluginId>')` once at the top of each of its files, then
 * `text('Not enough {0}', { 0: keyText(unit.name) })`: the key (in its data/i18n.csv) and the values.
 */
export function uiTexts(owner: string) {
	return (key: string, vars?: UiText['vars']): UiText => (vars ? { text: `${owner}.${key}`, vars } : { text: `${owner}.${key}` });
}

/** A key of any plugin as a text, e.g. a content name ("starter-content.Farm") put into a sentence. */
export const keyText = (key: string): UiText => ({ text: key });

/** How a reward line names what it gave: its own text if it has one, else its name's key. */
export const rewardName = (l: { name: string; label?: UiText }): UiText => l.label ?? keyText(l.name);

/** An icon as a text's var (drawn by the client; left out where only text fits). */
export const iconVar = (icon: string): UiIconVar => ({ icon });

/**
 * A cost (upkeep, load…) as a text's var, from amounts by resource and the resources' icons and names (the meta's in
 * the browser; or only their icons, by id, where a static view sends just those): zero amounts left out, in the
 * resources' order.
 */
export function costVar(
	amounts: Record<string, number>,
	known: readonly { id: string; name?: string; icon?: string }[] | Record<string, string>,
	options: { decimals?: number; unit?: string } = {},
): UiCostVar {
	const resources = Array.isArray(known)
		? known.map((r) => ({ id: r.id, name: r.name ?? r.id, icon: r.icon }))
		: Object.entries(known).map(([id, icon]) => ({ id, name: id, icon }));
	const ids = new Set(resources.map((r) => r.id));
	const cost = [
		...resources
			.filter((r) => (amounts[r.id] ?? 0) > 0)
			.map((r) => ({ ...(r.icon ? { icon: r.icon } : {}), name: r.name, amount: amounts[r.id] })),
		...Object.entries(amounts)
			.filter(([id, n]) => n > 0 && !ids.has(id))
			.map(([id, n]) => ({ name: id, amount: n })),
	];
	return { cost, ...options };
}

/** An icon, then a value (a number shown as it is: "<grain> +2/s", a price part "<wood>750"); no icon: the value alone. */
export const withIcon = (icon: string | undefined, value: string | UiText): UiText =>
	icon ? { text: 'i18n.{0}{1}', vars: { 0: iconVar(icon), 1: value } } : typeof value === 'string' ? literal(value) : value;

/** A var alone as a text (a cost or icon drawn on its own, e.g. in a component's template). */
export const asText = (v: UiVar): UiText => ({ text: 'i18n.{0}', vars: { 0: v } });

/** A cost var with nothing in it (zero amounts only): show "—" or "free" instead. */
export const isFree = (v: UiCostVar) => !v.cost.length;

/** A text shown as it is, never translated (a name a player typed). */
export const literal = (text: string): UiText => ({ text: 'i18n.{0}', vars: { 0: text } });
