/**
 * Icons in the widgets' data (`UiRow.icon`, `UiCard.icon`, `UiLine.icon`, a reward line's `icon`...): an emoji, or a
 * reference to art the client draws, "art:<scheme>:<key>|<fallback>". The widgets know no scheme: a client plugin
 * registers the renderer of its scheme at the client extension point "ui.icon" (web/widgets/Icon.vue), e.g.
 * "equipment" draws a piece's pixel icon from "<set>/<slot>/<rarity>". Without a renderer (or where only text fits:
 * a dropdown's option, a tooltip) the fallback emoji shows. Pure: both ends use it.
 */

/** The client extension point where art schemes register their renderer (a Vue component, by scheme). */
export const ICON_POINT = 'ui.icon';

/** An art icon: drawn by the renderer of `scheme` from `key`; `fallback` (an emoji) where there is none. */
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

/** The parts of an art icon; null: a plain icon (an emoji) or none. */
export function parseIcon(icon: string | undefined | null): ArtIcon | null {
	if (!icon?.startsWith('art:')) return null;
	const colon = icon.indexOf(':', 4);
	const bar = icon.lastIndexOf('|');
	if (colon < 0 || bar < colon) return null;
	return { scheme: icon.slice(4, colon), key: icon.slice(colon + 1, bar), fallback: icon.slice(bar + 1) };
}

/** What an icon shows as text: an emoji as it is, an art icon's fallback. */
export const plainIcon = (icon: string | undefined | null): string => parseIcon(icon)?.fallback ?? icon ?? '';
