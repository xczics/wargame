// The client half of the otherworld example: words its scouting mail (./report.ts). The grid needs no client code.
import { defineClientPlugin } from '../../web/core/game';
import { scouted } from './report';

export default defineClientPlugin({
	id: 'otherworld',
	setup(game) {
		game.clientPart(scouted);
	},
});
