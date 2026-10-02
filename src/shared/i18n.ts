/**
 * Texts sent to the client are UiTexts whose `text` is a full i18n key "<pluginId>.<key>" (src/plugins/i18n).
 * Their vars are values (numbers, amounts, names a player typed, heroes' name-part keys) or texts themselves:
 * the client translates the key and the vars that are UiTexts, nothing else.
 */
import type { UiText } from './ui';

/**
 * A plugin's texts: `const text = uiTexts('<pluginId>')` once at the top of each of its files, then
 * `text('Not enough {0}', { 0: keyText(unit.name) })`: the key (in its data/i18n.csv) and the values.
 */
export function uiTexts(owner: string) {
	return (key: string, vars?: UiText['vars']): UiText => (vars ? { text: `${owner}.${key}`, vars } : { text: `${owner}.${key}` });
}

/** A key of any plugin as a text, e.g. a content name ("starter-content.Farm") put into a sentence. */
export const keyText = (key: string): UiText => ({ text: key });

/** A text shown as it is, never translated (a name a player typed). */
export const literal = (text: string): UiText => ({ text: 'i18n.{0}', vars: { 0: text } });
