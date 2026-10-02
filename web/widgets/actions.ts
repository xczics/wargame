// Running a widget button (UiAction): ask first if it says so, then the command.
import type { UiAction } from '../../src/shared/ui';
import type { Game } from '../core/game';
import { uiText } from './text';

export async function runAction(game: Game, a: UiAction) {
	if (a.blocked) return;
	if (a.confirm && !confirm(uiText(game, a.confirm))) return;
	await game.command(a.command, a.payload ?? {});
}
