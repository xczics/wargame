/**
 * An expected, player-facing failure (bad input, not enough gold...). Safe to show to the client.
 * `owner`: the plugin whose translations hold the message (its i18n key is "<owner>.<message>").
 */
export class GameError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly owner?: string,
	) {
		super(message);
		this.name = 'GameError';
	}
}

/** A programming / configuration error in plugin wiring. Fails fast at kernel boot. */
export class PluginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PluginError';
	}
}
