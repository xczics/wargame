// Translating the server's UiText (src/shared/ui.ts) for the generic widgets.
import type { UiText } from '../../src/shared/ui';
import type { Game } from '../core/game';

export function uiText(game: Game, t: UiText | undefined): string {
	if (!t) return '';
	const vars = t.vars && Object.fromEntries(Object.entries(t.vars).map(([k, v]) => [k, typeof v === 'string' ? game.t(v) : v]));
	return game.t(t.text, vars);
}
