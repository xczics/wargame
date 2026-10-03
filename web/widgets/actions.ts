// Running a widget button (UiAction): ask first if it says so, then the command (or open a page or an
// entry, or change the client's parameters).
import type { UiAction } from '../../src/shared/ui';
import type { Game } from '../core/game';
import { uiText } from './text';

export async function runAction(game: Game, a: UiAction) {
	if (a.blocked) return;
	if (a.confirm && !confirm(uiText(game, a.confirm))) return;
	if (a.page) game.showPage(a.page);
	else if (a.entry) game.openEntry(a.entry);
	else if (a.params) for (const [k, v] of Object.entries(a.params)) await game.setParam(k, v);
	else if (a.command && (await game.command(a.command, a.payload ?? {})) && a.notice) game.notice(a.notice);
}
