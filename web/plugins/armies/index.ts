// The Army page's incoming attacks and marches, assembled in the browser from the armies plugin's data (./timers.ts),
// the marches settled when sent played out (./staged.ts) and the words of its forms (./forms.ts).
import { shallowRef, watch } from 'vue';
import type { ArmyMarch, ArmySent, GarrisonInfo, ResourcePool, StagedMarch, TroopsState, UnitCatalog } from '../../../src/shared/api';
import type { MarchRules } from '../../../src/shared/march';
import { patchHeldBefore } from '../../../src/shared/answered';
import { heroesOnDuty } from '../../../src/shared/duties';
import { garrisonMoved, stateMoved } from '../../../src/shared/troops';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import Arrival from './Arrival.vue';
import { sentFrom, sentHeroes, sentUnits } from './sent';
import {
	type ClientPaceModifier,
	gatherOrders,
	marchOf,
	orderOf,
	orderSeconds,
	ownMissions,
	type SentOrder,
	type TravelData,
} from './travel';
import { playing, stagedGarrison, stagedList, stagedPool, stagedTroops } from './staged';
import { views } from './views';

/** For the plugins whose commands send an army (`armies.dispatch` on the server): what the march did, told to the data held here. */
export interface ArmiesClient {
	/**
	 * The command sending troops succeeded (before its answer is in: `afterCommand`), with its answer's `reply` and clock;
	 * `mission`: what the march is for (the command's mission id).
	 */
	sent(payload: unknown, reply: Record<string, unknown>, now: number, mission: string): void;
	/** Its answer is in (`afterCommand` with `answered`). */
	answered(payload: unknown): void;
	/** A pace modifier's counterpart here (`armies.addPaceModifier` on the server), for the marches timed in the browser. */
	addPaceModifier(m: ClientPaceModifier): void;
	/** One way's seconds of `order` (to one's own settlement: `own`), as the server will time it; null: not known here. Reactive. */
	seconds(order: SentOrder, own: boolean): number | null;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		armies: ArmiesClient;
	}
}

/** At most this many settlements a gathering fetches from (`GATHER_MAX` on the server). */
const GATHER_MAX = 20;

export default defineClientPlugin({
	id: 'armies',
	dependsOn: ['forms'],
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Sending troops (user 2026-11-20: marched off, the garrison on another page still had them): gone from their
		// garrison held here, the heroes at their head on duty; the march into the marches held, from the payload, the id
		// the answer gives ("armies.sent") and when it arrives, worked out here as the server does (./travel.ts; user
		// 2026-11-24: "行军到达时间……前端是知道的呀"). What that needs not held (the speeds, the rules): asked for again.
		let sentAt = 0;
		const catalog = () => game.static<UnitCatalog>('troops.units');
		const modifiers: ClientPaceModifier[] = [];
		const travel = (): TravelData | null => {
			const speeds = game.view('armies.speeds');
			const rules = game.static<MarchRules>('armies.travel');
			return speeds && rules ? { speeds, rules, modifiers } : null;
		};
		const seconds = (order: SentOrder, own: boolean) => {
			const d = travel();
			const mine = game.view('settlements.mine');
			return d && mine ? orderSeconds(order, mine, own, d) : null;
		};
		/** The marches a send made, in the order of its answer's ids; null: not worked out here. */
		function marches(payload: unknown, ids: ArmySent[], now: number, mission: string, gather: boolean): ArmyMarch[] | null {
			const numbers = catalog();
			const rules = game.static<MarchRules>('armies.travel');
			const mine = game.view('settlements.mine');
			const from = sentFrom(payload);
			const fromName = game.view('troops.state')?.garrisons.find((g) => g.settlement === from)?.name;
			if (!numbers || !rules || !mine || !fromName) return null;
			const own = ownMissions.has(mission);
			const orders = gather ? gatherOrders(payload, mine, GATHER_MAX) : [orderOf(payload)];
			if (!orders) return null;
			const out: ArmyMarch[] = [];
			for (const order of orders) {
				const t = order ? seconds(order, own) : null;
				if (!order || t === null) return null;
				// Settled at once on the server (`armies.staged`): no id for it.
				if (own && t < rules.minSeconds) continue;
				const id = ids[out.length];
				if (!id) return null;
				out.push(marchOf(order, id, { now, seconds: t, mission, fromName, catalog: numbers }));
			}
			return out.length === ids.length ? out : null;
		}
		function sentBy(payload: unknown, reply: Record<string, unknown>, now: number, mission: string, gathering: boolean) {
			sentAt = Date.now();
			const from = sentFrom(payload);
			const units = sentUnits(payload);
			if (from) {
				game.patchView<TroopsState>('troops.state', (s) => stateMoved(s, from, units, catalog()));
				game.patchView<GarrisonInfo | null>('troops.garrison', (g) => garrisonMoved(g, from, units, catalog()));
			}
			heroesOnDuty(game.patchView, sentHeroes(payload), { duty: 'command', target: null });
			// Settled at once (`armies.staged`, no "armies.sent"): nothing stored to list.
			const sent = (reply['armies.sent'] ?? []) as ArmySent[];
			if (!sent.length) return;
			const made = marches(payload, sent, now, mission, gathering);
			if (!made) return game.markStale('armies.list');
			game.patchView<ArmyMarch[]>('armies.list', (list) => [...list, ...made.filter((m) => !list.some((x) => x.id === m.id))]);
		}
		const client: ArmiesClient = {
			sent: (payload, reply, now, mission) => sentBy(payload, reply, now, mission, false),
			addPaceModifier: (m) => void modifiers.push(m),
			seconds,
			answered(payload) {
				// Settled at once (a short march between own settlements, `armies.staged`): the server has them back home or
				// stationed there already, and the browser plays the trip out from that. What was held elsewhere goes back to
				// as it was, asked for again where it shows next.
				if (!game.view('armies.staged')?.length) return;
				const from = sentFrom(payload);
				if (!from) return;
				const back = Object.fromEntries(Object.entries(sentUnits(payload)).map(([u, n]) => [u, -n]));
				patchHeldBefore<TroopsState>(game, 'troops.state', sentAt, (s) => stateMoved(s, from, back, catalog()));
				patchHeldBefore<GarrisonInfo | null>(game, 'troops.garrison', sentAt, (g) => garrisonMoved(g, from, back, catalog()));
				game.markStale('troops.state');
				game.markStale('troops.garrison');
			},
		};
		game.provide('armies', client);
		// Each command's mission (`armies.send` may name another: founding, for one).
		const missionOf: Record<string, string> = {
			'armies.transfer': 'transfer',
			'armies.transport': 'transport',
			'armies.gather': 'transport',
		};
		const sending = (type: string) => ['armies.send', 'armies.transfer', 'armies.transport', 'armies.gather'].includes(type);
		game.afterCommand(sending, (type, payload, reply, now) =>
			sentBy(payload, reply, now, missionOf[type] ?? (payload as { mission?: string }).mission ?? 'attack', type === 'armies.gather'),
		);
		// The expected arrival in the forms sending troops (./forms.ts adds the field).
		game.use('forms').widget('armies.arrival', { component: Arrival, payload: () => ({}) });
		game.afterCommand(sending, (_type, payload) => client.answered(payload), { answered: true });
		// Only in a command's answer: kept here (memory only: after a reload they show as arrived, as the server has them).
		game.need('armies.staged');
		const staged = shallowRef<StagedMarch[]>([]);
		let over: ReturnType<typeof setTimeout> | undefined;
		watch(
			() => game.view('armies.staged'),
			(sent) => {
				if (!sent?.length) return;
				const now = game.serverNow();
				staged.value = [...playing(staged.value, now).filter((m) => !sent.some((x) => x.id === m.id)), ...sent];
				// Once the last is home, none is left: the displays stop reading the clock (2026-10-25: they went on ticking
				// ten times a second for the rest of the session). One timer, at the latest return.
				clearTimeout(over);
				const last = Math.max(...staged.value.map((m) => m.returnsAt));
				over = setTimeout(() => (staged.value = playing(staged.value, game.serverNow())), Math.max(0, last - now) + 100);
			},
		);
		/** The staged marches, with the clock read only while there are some (so displays do not tick for nothing). */
		const at = () => (staged.value.length ? { list: staged.value, now: game.serverNow() } : null);
		game.adjust<ResourcePool>('resources.pool', (pool) => {
			const s = at();
			return s ? stagedPool(pool, s.list, s.now) : pool;
		});
		game.adjust<GarrisonInfo>('troops.garrison', (g) => {
			const s = at();
			return s ? stagedGarrison(g, s.list, s.now) : g;
		});
		game.adjust<TroopsState>('troops.state', (state) => {
			const s = at();
			return s ? stagedTroops(state, s.list, s.now) : state;
		});
		game.adjust<ArmyMarch[]>('armies.list', (list) => {
			const s = at();
			return s ? stagedList(list, s.list, s.now) : list;
		});
	},
});
