// Translating the server's UiText (src/shared/ui.ts) for the generic widgets. (People's names sent as
// name-part keys are spelled by `game.t` itself.)
import type { UiText } from '../../src/shared/ui';
import type { Game } from '../core/game';

export function uiText(game: Game, t: UiText | undefined): string {
	return t ? game.t(t) : '';
}
