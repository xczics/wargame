// The starter icon set's art (./sprites.ts: one 16x16 pixel sprite per icon id the official plugins use), given to the
// drawn icon set (`icons` client service). Replacing the art = editing ./sprites.ts.
import { defineClientPlugin } from '../../core/game';
import { SPRITES } from './sprites';

export default defineClientPlugin({
	id: 'starter-icons',
	dependsOn: ['icons'],
	setup(game) {
		game.use('icons').add(SPRITES);
	},
});
