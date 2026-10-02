import type { UiText } from '../shared/ui';

/**
 * An expected, player-facing failure (bad input, not enough gold...). Safe to show to the client as `text`:
 * the message is a key of `owner`'s translations ("<owner>.<message>"; the kernel's own are "kernel.<message>",
 * in src/kernel/i18n.csv), its placeholders filled from `vars`. Or a ready text (a hook's reason, another
 * plugin's): then that is what is shown.
 */
export class GameError extends Error {
	readonly text: UiText;
	constructor(
		readonly code: string,
		message: string | UiText,
		readonly status = 400,
		readonly owner = 'kernel',
		vars?: UiText['vars'],
	) {
		super(typeof message === 'string' ? message : message.text);
		this.name = 'GameError';
		this.text = typeof message === 'string' ? { text: `${owner}.${message}`, ...(vars ? { vars } : {}) } : message;
	}
}

/**
 * A plugin's errors: `const fail = gameErrors('<pluginId>')` once at the top of each of its files, then
 * `throw fail(code, 'Unknown tech')`, or with values `throw fail(code, text('Not enough {0}', { 0: keyText(unit.name) }))`.
 * Either way the message is a key of that plugin's data/i18n.csv (scripts/check.mjs checks it).
 */
export function gameErrors(owner: string) {
	return (code: string, message: string | UiText, status = 400) => new GameError(code, message, status, owner);
}

/** What to show for a caught error inside another message: a `GameError`'s text, anything else as written. */
export function errorText(err: unknown): UiText {
	return err instanceof GameError ? err.text : { text: 'i18n.{0}', vars: { 0: String(err instanceof Error ? err.message : err) } };
}

/** A programming / configuration error in plugin wiring. Fails fast at kernel boot. */
export class PluginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PluginError';
	}
}
