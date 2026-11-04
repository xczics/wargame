/**
 * Icons in the widgets' data (`UiRow.icon`, `UiCard.icon`, `UiLine.icon`, a reward line's `icon`, a text's icon var…):
 * an icon id ("grain", kebab-case), or a reference to art of a scheme of its own, "art:<scheme>:<key>|<fallback>"
 * (the fallback an icon id). The widgets know no scheme: a client plugin registers the renderer of its scheme at the
 * client extension point "ui.icon" (web/widgets/Icon.vue). Icon ids are the scheme "icon" (the drawn icon set, from an
 * art pack: web/plugins/icons); "equipment" draws a piece from "<set>/<slot>/<rarity>". Icons are data, never part of
 * a text (user 2026-11-04: "服务端禁止拼接文字"): where only text fits (a dropdown's option, a tooltip) there is none.
 * An emoji (a third party's older data) still shows as it is. Pure: both ends use it.
 */

/** The scheme of plain icon ids (the drawn icon set). */
export const ICON_SET = 'icon';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Whether `icon` is an icon id (else an art icon or an emoji). */
export const isIconId = (icon: string) => ID.test(icon);

/** The client extension point where art schemes register their renderer (a Vue component, by scheme). */
export const ICON_POINT = 'ui.icon';

/** An art icon: drawn by the renderer of `scheme` from `key`; `fallback` (an icon id) where there is none. */
export function artIcon(scheme: string, key: string, fallback = ''): string {
	if (!/^[a-z0-9-]+$/.test(scheme)) throw new Error(`Icon scheme "${scheme}": lower-case letters, digits and "-" only`);
	if (key.includes('|')) throw new Error(`Icon key "${key}": no "|"`);
	return `art:${scheme}:${key}|${fallback}`;
}

export interface ArtIcon {
	scheme: string;
	key: string;
	fallback: string;
}

/** The parts of an icon to draw (an icon id is the scheme "icon"); null: an emoji or none. */
export function parseIcon(icon: string | undefined | null): ArtIcon | null {
	if (icon && isIconId(icon)) return { scheme: ICON_SET, key: icon, fallback: '' };
	if (!icon?.startsWith('art:')) return null;
	const colon = icon.indexOf(':', 4);
	const bar = icon.lastIndexOf('|');
	if (colon < 0 || bar < colon) return null;
	return { scheme: icon.slice(4, colon), key: icon.slice(colon + 1, bar), fallback: icon.slice(bar + 1) };
}

/** The icon id an art icon falls back to (drawn where its own renderer is missing), else the icon itself. */
export const fallbackIcon = (icon: string): string => {
	const art = parseIcon(icon);
	return art && art.scheme !== ICON_SET ? art.fallback : icon;
};
