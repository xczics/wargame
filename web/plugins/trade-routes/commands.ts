// What the trade routes' commands did, told to the player's data held in the browser (user 2026-11-20: "你告诉前端成功
// 了，前端不就能更新了吗？"): the heroes on their duty or back, the men gone from their garrison or back, the merchant's
// goods in the inventory; what only the server knows (a fight's losses and drops, what a merchant has once the team
// moves) asked for again where it shows next.
import type { GarrisonInfo, HeroesState, ShopWallet, TroopsState, UnitCatalog } from '../../../src/shared/api';
import { patchHeldBefore, staleUnlessAnswered } from '../../../src/shared/answered';
import { heroesOnDuty } from '../../../src/shared/duties';
import {
	type TradeColumn,
	type TradeMerchant,
	type TradeRoutesState,
	type TradeRoutesStatic,
	tradePair,
	tradeSeconds,
} from '../../../src/shared/trade-routes';
import { postLevels } from './post-levels';
import { boughtOne, teamMen } from './told';
import { garrisonMoved, stateMoved } from '../../../src/shared/troops';
import type { Game } from '../../core/game';

/** The heroes' duty on a trade route (the server plugin's). */
const DUTY = 'trade-routes.expedition';

export function tellCommands(game: Game) {
	const catalog = () => game.static<UnitCatalog>('troops.units');
	const move = (settlement: string, men: Record<string, number>, since?: number) => {
		const state = (s: TroopsState) => stateMoved(s, settlement, men, catalog());
		const garrison = (g: GarrisonInfo | null) => garrisonMoved(g, settlement, men, catalog());
		if (since === undefined) {
			game.patchView<TroopsState>('troops.state', state);
			game.patchView<GarrisonInfo | null>('troops.garrison', garrison);
		} else {
			patchHeldBefore<TroopsState>(game, 'troops.state', since, state);
			patchHeldBefore<GarrisonInfo | null>(game, 'troops.garrison', since, garrison);
		}
	};

	// Set out: the heroes on the route's duty, the men gone from the garrison, no last fight; where the team stands and the
	// merchant there the server decides (the trade post's entry, where it is sent from, brings the team's state).
	game.afterCommand('trade-routes.depart', (_type, payload) => {
		const p = payload as { settlement: string; team: TradeColumn[]; auxiliaries?: Record<string, number> };
		move(p.settlement, teamMen(p.team, p.auxiliaries ?? {}));
		const name =
			game
				.held<TroopsState>('troops.state')
				.flatMap((h) => h.value?.garrisons ?? [])
				.find((g) => g.settlement === p.settlement)?.name ??
			game.held<HeroesState | null>('heroes.state').find((h) => h.value?.settlement.id === p.settlement)?.value?.settlement.name ??
			null;
		heroesOnDuty(
			game.patchView,
			p.team.map((c) => c.hero),
			{ duty: DUTY, target: p.settlement, targetName: name },
		);
		game.patchView<unknown>('trade-routes.battle', () => null);
		game.markStale('trade-routes.merchant');
	});
	staleUnlessAnswered(game, 'trade-routes.depart', ['trade-routes.state']);

	// Called home: back at once when the stamina spent is past (the server's answer has no team then): the heroes free, the
	// men in their garrison. Otherwise nothing changes until they are back (the page wakes at that time).
	let out: NonNullable<TradeRoutesState['expedition']> | null = null;
	let sent = 0;
	game.afterCommand('trade-routes.recall', () => {
		sent = Date.now();
		out = game.view('trade-routes.state')?.expedition ?? null;
	});
	game.afterCommand(
		'trade-routes.recall',
		() => {
			const e = out;
			out = null;
			if (!e || game.view('trade-routes.state')?.expedition) return;
			move(e.settlement, Object.fromEntries(Object.entries(teamMen(e.team, e.auxiliaries)).map(([u, n]) => [u, -n])), sent);
			heroesOnDuty(
				game.patchView,
				e.team.map((c) => c.hero),
				{ duty: 'idle', target: null },
			);
			game.patchView<unknown>('trade-routes.battle', () => null);
		},
		{ answered: true },
	);

	// A fight: its losses, drops, experience and epiphanies only the server knows (a battle, rolls). What its answer (the
	// Trade Routes page's) does not bring is asked for again where it shows next (a piece dropped comes whole with the
	// answer: "equipment.created").
	staleUnlessAnswered(game, 'trade-routes.fight', [
		'heroes.state',
		'heroes.list',
		'realms.overview',
		'items.owned',
		'shop.wallet',
		'troops.state',
		'troops.garrison',
	]);

	// Bought: paid in coupons, one fewer left today, an item in the inventory held here (a piece of equipment is made by
	// the server: the answer says it whole, "equipment.created").
	game.afterCommand('trade-routes.buy', (_type, payload) => {
		const { goods } = payload as { goods: string };
		const g = game
			.held<TradeMerchant | null>('trade-routes.merchant')
			.map((h) => h.value?.goods.find((x) => x.id === goods))
			.find(Boolean);
		game.patchView<TradeMerchant | null>('trade-routes.merchant', (m) => boughtOne(m, goods));
		if (!g) return;
		game.patchView<ShopWallet>('shop.wallet', (w) => ({ ...w, balance: w.balance - g.price }));
		const item = g.preview.item;
		if (item) {
			const n = g.preview.count ?? 1;
			game.patchView<Record<string, number>>('items.owned', (owned) => ({ ...owned, [item]: (owned[item] ?? 0) + n }));
		}
	});
	// Traded: today's amount that way up, and the deal under way at the post, timed by the post's level and the rules
	// (static); the server says only its id ("trade-routes.deal"; user 2026-11-25: "每进行一次交易，都创建一个时间队列").
	game.afterCommand('trade-routes.trade', (_type, payload, reply, now) => {
		const p = payload as { settlement: string; from: string; to: string; amount: number };
		const id = reply['trade-routes.deal'];
		const rules = game.static<TradeRoutesStatic>('trade-routes.routes')?.trade;
		const level = postLevels.get(p.settlement);
		if (typeof id !== 'string' || !rules || !level) return game.markStale('trade-routes.state');
		const pair = tradePair(p.from, p.to);
		const deal = {
			id,
			settlement: p.settlement,
			resource: p.to,
			amount: p.amount,
			startedAt: now,
			finishesAt: now + tradeSeconds(rules, level) * 1000,
		};
		game.patchView<TradeRoutesState>('trade-routes.state', (s) => ({
			...s,
			trade: { ...s.trade, traded: { ...s.trade.traded, [pair]: (s.trade.traded[pair] ?? 0) + p.amount }, deals: [...s.trade.deals, deal] },
		}));
	});
}
