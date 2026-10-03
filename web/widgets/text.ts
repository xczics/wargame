// Translating the server's UiText (src/shared/ui.ts) for the generic widgets. (People's names sent as
// name-part keys are spelled by `game.t` itself.)
import type { UiText } from '../../src/shared/ui';
import type { Game } from '../core/game';

export function uiText(game: Game, t: UiText | undefined): string {
	return t ? game.t(t) : '';
}

/** Hover text: why a button is disabled, else its `hint` lines (details that do not fit on it), one per line. */
export function hintText(game: Game, x: { blocked?: UiText; hint?: UiText[] }): string | undefined {
	if (x.blocked) return uiText(game, x.blocked);
	return x.hint?.length ? x.hint.map((t) => uiText(game, t)).join('\n') : undefined;
}
