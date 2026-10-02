// Countdowns of the generic widgets (server times in ms).
import { duration } from '../../src/shared/format';
import type { Game } from '../core/game';

export const left = (game: Game, endsAt: number) => duration((endsAt - game.serverNow()) / 1000);
