// Running a widget button (UiAction): ask first if it says so, then the command (or open a page or an
// entry, or change the client's parameters). While its command runs the button is disabled and the frame
// says what the player is waiting for (the action's `pending`, else "<label>: working…").
import { reactive } from 'vue';
import type { UiAction } from '../../src/shared/ui';
import type { Game } from '../core/game';
import { uiText } from './text';

/** Buttons whose command is running (same command and payload: one at a time). */
const runningNow = reactive(new Set<string>());
const keyOf = (a: UiAction) => `${a.command}|${JSON.stringify(a.payload ?? {})}`;
export const running = (a: UiAction) => !!a.command && runningNow.has(keyOf(a));

export async function runAction(game: Game, a: UiAction) {
	if (a.blocked || running(a)) return;
	if (a.confirm && !confirm(uiText(game, a.confirm))) return;
	if (a.page) game.showPage(a.page);
	else if (a.entry) game.openEntry(a.entry);
	else if (a.params) for (const [k, v] of Object.entries(a.params)) await game.setParam(k, v);
	else if (a.command) {
		const key = keyOf(a);
		runningNow.add(key);
		try {
			const pending = a.pending ? uiText(game, a.pending) : game.t('{0}: working…', { 0: uiText(game, a.label).replace(/[·\s]+$/, '') });
			const ok = await game.command(a.command, a.payload ?? {}, { pending, done: !a.notice });
			if (ok && a.notice) game.notice(a.notice);
		} finally {
			runningNow.delete(key);
		}
	}
}
