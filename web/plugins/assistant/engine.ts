// The assistant at work (docs/design/gameplay.md §15): after a sync (the periodic one, or one at a time something was
// due), it looks at the player's goals and sends the commands a player would, at most a few a scan. What it needs to
// judge comes in one state request (only the views its goals need, settlements' by parameters); the commands go
// without views (nothing worked out for them), and the screen resyncs once after. Every command is checked by the
// server as usual: what it refuses is logged, and the task follows its policy.
import { watch } from 'vue';
import type {
	ArmyInfo,
	ClientState,
	GarrisonInfo,
	HeroInfo,
	NearbyOverview,
	RealmsOverview,
	ResourcePool,
	SettlementDetail,
	SettlementSummary,
} from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { margin } from '../../../src/shared/realms';
import { ApiError } from '../../core/api';
import type { Game } from '../../core/game';
import type { BuildTask, CampRule, HeroPick, LevelRule, PointRule, Policy, RealmTask, Store } from './store';

export interface AssistantSettings {
	enabled: boolean;
	commandsPerScan: number;
}

/** Each lane of an NPC camp, by tier, for a kind and level (static view `npc-camps.garrisons`). */
type Garrisons = Record<string, Record<string, { lane: Record<string, number> }>>;

const LANES = 5;
/** A scan at most this often from syncs alone (the periodic sync is a minute); sooner when something fell due. */
const SCAN_EVERY = 45_000;

interface Seen {
	details: Record<string, SettlementDetail | null>;
	pools: Record<string, ResourcePool | null>;
	heroes: HeroInfo[];
	realms: RealmsOverview | null;
	garrisons: GarrisonInfo[];
	armies: ArmyInfo[];
	nearby: Record<string, NearbyOverview>;
	now: number;
}

export function startEngine(game: Game, store: Store) {
	const { data, log, flag } = store;
	const t = (text: string, vars?: Record<string, string | number>) => game.t(text, vars);
	const settings = () => game.static<AssistantSettings>('assistant.settings');
	let running = false;
	let lastScan = 0;
	let dueAt = Infinity;

	watch(
		() => game.state.value,
		() => {
			const now = Date.now();
			if (running || !settings()?.enabled || !data.on) return;
			if (now - lastScan < SCAN_EVERY && game.serverNow() < dueAt) return;
			void scan();
		},
	);

	const errorOf = (err: unknown) => (err instanceof ApiError ? (err.text ? game.t(err.text) : err.message) : String(err));
	async function send(type: string, payload: unknown): Promise<string | null> {
		try {
			// No views asked: the server works nothing out for the answer; the screen resyncs once after the scan.
			await game.request<ClientState>('/api/command', { method: 'POST', body: { type, payload } });
			return null;
		} catch (err) {
			return errorOf(err) || 'failed';
		}
	}

	async function scan() {
		running = true;
		lastScan = Date.now();
		dueAt = Infinity;
		try {
			const seen = await fetchSeen();
			if (!seen) return;
			let budget = settings()?.commandsPerScan ?? 5;
			const spend = () => budget-- > 0;
			let sent = 0;
			const run = async (type: string, payload: unknown) => {
				const err = await send(type, payload);
				if (!err) sent++;
				return err;
			};
			if (data.points.on) await points(seen, spend, run);
			if (data.realms.on) await realms(seen, spend, run);
			if (data.build.on) await build(seen, spend, run);
			if (data.camps.on) await camps(seen, spend, run);
			if (sent) await game.refresh();
			if (dueAt < Infinity) game.refreshAt(dueAt + 1_000);
		} catch (err) {
			log('assistant', false, t('The assistant could not look: {0}', { 0: errorOf(err) }));
		} finally {
			running = false;
		}
	}
	const due = (at: number) => (dueAt = Math.min(dueAt, at));

	/* ----- what it needs, in one request --------------------------------------------------- */

	async function fetchSeen(): Promise<Seen | null> {
		const mine = (game.view('settlements.mine') ?? []) as SettlementSummary[];
		const views = new Set<string>();
		const instances: { key: string; view: string; params: Record<string, string> }[] = [];
		const cities = new Set<string>();
		if (data.build.on) for (const task of data.build.tasks) cities.add(task.settlement);
		for (const id of cities) {
			instances.push({ key: `detail:${id}`, view: 'settlements.detail', params: { settlement: id } });
			instances.push({ key: `pool:${id}`, view: 'resources.pool', params: { settlement: id } });
		}
		const leveling = data.realms.on && (data.realms.queue.length || data.realms.leveling.some((r) => r.on));
		const pointing = data.points.on && data.points.rules.some((r) => r.on);
		const raiding = data.camps.on && data.camps.rules.some((r) => r.on);
		if (leveling) views.add('realms.overview');
		if (leveling || pointing || raiding) views.add('heroes.list');
		if (raiding) {
			views.add('troops.overview');
			views.add('armies.list');
			for (const rule of data.camps.rules.filter((r) => r.on))
				for (const s of citiesOf(rule.from, mine))
					if (!instances.some((i) => i.key === `nearby:${s.id}`))
						instances.push({
							key: `nearby:${s.id}`,
							view: 'settlements.nearby',
							params: { x: String(s.x), y: String(s.y), r: String(Math.max(1, rule.distance)), npc: '1' },
						});
		}
		if (!views.size && !instances.length) return null;
		const query = new URLSearchParams({ views: [...views].join(',') });
		if (instances.length) query.set('instances', JSON.stringify(instances));
		const state = await game.request<ClientState>(`/api/state?${query}`);
		const v = state.views as Record<string, unknown>;
		const got = (state.instances ?? {}) as Record<string, unknown>;
		const pick = <T>(prefix: string) =>
			Object.fromEntries(Object.entries(got).flatMap(([k, x]) => (k.startsWith(prefix) ? [[k.slice(prefix.length), x as T]] : [])));
		return {
			details: pick<SettlementDetail | null>('detail:'),
			pools: pick<ResourcePool | null>('pool:'),
			heroes: (v['heroes.list'] as HeroInfo[] | undefined) ?? [],
			realms: (v['realms.overview'] as RealmsOverview | undefined) ?? null,
			garrisons: (v['troops.overview'] as GarrisonInfo[] | undefined) ?? [],
			armies: (v['armies.list'] as ArmyInfo[] | undefined) ?? [],
			nearby: pick<NearbyOverview>('nearby:'),
			now: state.now,
		};
	}

	/** What happens to a task that cannot go ahead (gameplay.md §15.5): true when the rest of its queue must wait. */
	function fail<T extends { id: string; onFail: Policy; note?: string }>(list: T[], task: T, area: 'build' | 'realms', why: string) {
		task.note = why;
		if (task.onFail === 'cancel') {
			list.splice(list.indexOf(task), 1);
			log(area, false, t('Removed from the queue: {0}', { 0: why }));
			return false;
		}
		if (task.onFail === 'block') {
			log(area, false, t('The queue waits: {0}', { 0: why }));
			flag(area === 'build' ? t('The building queue is blocked') : t('The adventure queue is blocked'));
			return true;
		}
		log(area, false, t('Skipped for now: {0}', { 0: why }));
		return false;
	}

	/* ----- building queue (gameplay.md §15.2) ---------------------------------------------- */

	const buildingName = (id: string) => game.t(game.meta.buildings?.find((b) => b.id === id)?.name ?? id);
	async function build(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const tasks = data.build.tasks;
		const waiting = new Set<string>(); // settlements whose earlier task waits: later ones there wait too (in order)
		for (const task of [...tasks]) {
			if (!tasks.includes(task)) continue;
			const d = seen.details[task.settlement];
			if (!d) {
				if (fail(tasks, task, 'build', t('That settlement is gone'))) return;
				continue;
			}
			const slot = d.districts.find((x) => x.id === task.district)?.slots.find((x) => x.slot === task.slot);
			const what = t('{0} Lv {1} in {2}', { 0: buildingName(task.building), 1: task.level, 2: game.t(d.name) });
			if (!slot) {
				if (fail(tasks, task, 'build', t('No such slot: {0}', { 0: what }))) return;
				continue;
			}
			const cur = slot.current;
			const cons = slot.construction;
			if (cur?.building === task.building && cur.level >= task.level) {
				tasks.splice(tasks.indexOf(task), 1);
				log('build', true, t('Built: {0}', { 0: what }));
				continue;
			}
			if (cons) {
				due(cons.finishesAt);
				task.note = t('Waiting: being built');
				continue;
			}
			if (cur && cur.building !== task.building) {
				if (fail(tasks, task, 'build', t('Another building stands there: {0}', { 0: what }))) return;
				continue;
			}
			if ((cur?.level ?? 0) + 1 < task.level) {
				task.note = t('Waiting for the level before');
				continue;
			}
			if (waiting.has(d.id)) {
				task.note = t('Waiting for the task before');
				continue;
			}
			if (d.limits.queueUsed >= d.limits.queue) {
				task.note = t('Waiting: the construction slots are taken');
				waiting.add(d.id);
				continue;
			}
			const option = slot.options.find((o) => o.building === task.building && o.level === task.level);
			if (!option) {
				if (fail(tasks, task, 'build', t('Cannot be built there: {0}', { 0: what }))) return;
				continue;
			}
			if (option.blocked) {
				if (fail(tasks, task, 'build', `${what}: ${game.t(option.blocked)}`)) return;
				continue;
			}
			const short = shortOf(seen, d.id, option.cost);
			if (short) {
				task.note = t('Waiting for {0}', { 0: short });
				waiting.add(d.id);
				continue;
			}
			if (!spend()) return;
			const err = await run('buildings.construct', { settlement: d.id, district: task.district, slot: task.slot, building: task.building });
			if (err) {
				if (fail(tasks, task, 'build', `${what}: ${err}`)) return;
				continue;
			}
			task.note = t('Started');
			log('build', true, t('Started: {0}', { 0: what }));
			// What this scan knows now: the slot taken, the stock spent.
			d.limits.queueUsed++;
			slot.construction = {
				building: task.building,
				targetLevel: task.level,
				startedAt: seen.now,
				finishesAt: seen.now + option.seconds * 1000,
			};
			due(seen.now + option.seconds * 1000);
			const pool = seen.pools[d.id];
			if (pool) for (const [r, n] of Object.entries(option.cost)) pool.amounts[r] = (pool.amounts[r] ?? 0) - n;
		}
	}
	/** The first resource there is not enough of (after what the player keeps back), or null. */
	function shortOf(seen: Seen, settlement: string, cost: Record<string, number>) {
		const pool = seen.pools[settlement];
		if (!pool) return null;
		const elapsed = Math.max(0, (seen.now - pool.at) / 1000);
		for (const [r, n] of Object.entries(cost)) {
			const have = Math.min(pool.capacity, (pool.amounts[r] ?? 0) + (pool.rates[r] ?? 0) * elapsed);
			const keep = data.build.reserveBy[settlement]?.[r] ?? data.build.reserve[r] ?? 0;
			if (have - keep < n) return game.t(game.meta.resources?.find((x) => x.id === r)?.name ?? r);
		}
		return null;
	}

	/* ----- heroes chosen by a rule (gameplay.md §15.3.0) ----------------------------------- */

	interface HeroState {
		away: Set<string>;
		injured: Set<string>;
	}
	const heroState = (seen: Seen): HeroState => ({
		away: new Set(seen.realms?.adventures.map((a) => a.hero) ?? []),
		injured: new Set(seen.realms?.injured.map((i) => i.hero) ?? []),
	});
	const stateOf = (h: HeroInfo, s: HeroState) =>
		s.injured.has(h.id) ? 'injured' : s.away.has(h.id) ? 'adventure' : h.duty === 'idle' ? 'idle' : 'duty';
	const total = (h: HeroInfo, attr: string) => (h.attrs[attr] ?? 0) + (h.bonus[attr] ?? 0);
	function matches(pick: HeroPick, h: HeroInfo, s: HeroState) {
		if (pick.exclude.includes(h.id)) return false;
		if (pick.ids.includes(h.id)) return true;
		if (!pick.byConditions) return false;
		if (pick.levelMin !== undefined && h.level < pick.levelMin) return false;
		if (pick.levelMax !== undefined && h.level > pick.levelMax) return false;
		if (pick.talentMin !== undefined && h.talent < pick.talentMin) return false;
		if (pick.talentMax !== undefined && h.talent > pick.talentMax) return false;
		if (pick.gender && h.gender !== pick.gender) return false;
		if (pick.homes.length && !pick.homes.includes(h.home)) return false;
		if (pick.states.length && !pick.states.includes(stateOf(h, s))) return false;
		return pick.attrs.every((c) => (c.op === '>=' ? total(h, c.attr) >= c.value : total(h, c.attr) <= c.value));
	}
	/** The heroes of a pick, named ones first, then in its order. */
	function chosen(pick: HeroPick, heroes: HeroInfo[], s: HeroState) {
		const list = heroes.filter((h) => matches(pick, h, s));
		const key = (h: HeroInfo) =>
			pick.order === 'levelAsc'
				? h.level
				: pick.order === 'levelDesc'
					? -h.level
					: pick.order === 'nearUp'
						? h.expToNext === null
							? Infinity
							: h.expToNext - h.exp
						: pick.order === 'attr'
							? -total(h, pick.orderAttr ?? '')
							: Math.random();
		return list.sort((a, b) => Number(pick.ids.includes(b.id)) - Number(pick.ids.includes(a.id)) || key(a) - key(b));
	}
	/** Whether taking `h` away leaves its home the heroes the pick says to keep there. */
	function canLeave(pick: HeroPick, h: HeroInfo, heroes: HeroInfo[], s: HeroState) {
		if (!pick.keepPerCity) return true;
		const home = heroes.filter((x) => x.home === h.home && x.id !== h.id && !s.away.has(x.id) && !s.injured.has(x.id));
		return home.length >= pick.keepPerCity;
	}

	/* ----- free points (gameplay.md §15.4.1) ----------------------------------------------- */

	async function points(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const s = heroState(seen);
		const done = new Set<string>();
		// Rules naming a hero first, then the rest in their order.
		const rules = [...data.points.rules.filter((r) => r.on)].sort((a, b) => Number(!!b.heroes.ids.length) - Number(!!a.heroes.ids.length));
		for (const rule of rules)
			for (const h of chosen(rule.heroes, seen.heroes, s)) {
				if (done.has(h.id)) continue;
				done.add(h.id);
				const free = h.freePoints - rule.keep;
				if (free <= 0) continue;
				const plan = planPoints(rule, h, free);
				if (!Object.keys(plan).length) continue;
				if (!spend()) return;
				const err = await run('heroes.allocate', { hero: h.id, points: plan });
				const who = heroName(h);
				if (err) log('points', false, t('{0}: {1}', { 0: who, 1: err }));
				else
					log(
						'points',
						true,
						t('{0}: points spent ({1})', {
							0: who,
							1: Object.entries(plan)
								.map(([a, n]) => `${attrName(a)} +${n}`)
								.join(', '),
						}),
					);
			}
	}
	/** Where `free` points go by the rule's stages: targets first, then shares kept close (counting what went before). */
	function planPoints(rule: PointRule, h: HeroInfo, free: number) {
		const value = (a: string) => (rule.basis === 'free' ? (h.alloc[a] ?? 0) : total(h, a)) + (plan[a] ?? 0);
		const plan: Record<string, number> = {};
		let left = free;
		for (const stage of rule.stages) {
			if (left <= 0) break;
			if (stage.attr && stage.target !== undefined) {
				const n = Math.min(left, Math.max(0, Math.ceil(stage.target - value(stage.attr))));
				if (n) plan[stage.attr] = (plan[stage.attr] ?? 0) + n;
				left -= n;
				if (value(stage.attr) < stage.target) break; // not there yet: later stages wait
				continue;
			}
			const shares = Object.entries(stage.ratio ?? {}).filter(([, w]) => w > 0);
			if (!shares.length) continue;
			// One point at a time to the attribute furthest below its share: the shares hold over many level-ups.
			for (; left > 0; left--) {
				let best = shares[0][0];
				let lowest = Infinity;
				for (const [a, w] of shares) {
					const r = value(a) / w;
					if (r < lowest) {
						lowest = r;
						best = a;
					}
				}
				plan[best] = (plan[best] ?? 0) + 1;
			}
		}
		return plan;
	}
	const attrName = (id: string) => game.t(game.meta.heroes?.attributes.find((a) => a.id === id)?.name ?? id);
	// Name-part keys, spelled for the locale by the frame (as the server's `heroes.nameKey`).
	const heroName = (h: HeroInfo) => game.t(nameKey(h));

	/* ----- adventures: the queue and levelling (gameplay.md §15.3, §15.3.1) ---------------- */

	async function realms(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const ov = seen.realms;
		if (!ov) return;
		const s = heroState(seen);
		for (const a of ov.adventures) due(a.finishesAt);
		for (const i of ov.injured) if (i.healingUntil) due(i.healingUntil);
		const byId = new Map(seen.heroes.map((h) => [h.id, h]));
		const queued = new Set(data.realms.queue.map((q) => q.hero));
		// The queue: in order; a hero's next run when it is back.
		const queue = data.realms.queue;
		const started = new Set<string>();
		for (const task of [...queue]) {
			if (!queue.includes(task)) continue;
			const h = byId.get(task.hero);
			const realm = ov.realms.find((r) => r.id === task.realm);
			if (!h || !realm?.unlocked || !realm.tasks[task.task]) {
				const why = !h ? t('That hero is gone') : t('That realm or task is not open');
				if (fail(queue, task, 'realms', why)) return;
				continue;
			}
			if (started.has(h.id) || s.away.has(h.id) || s.injured.has(h.id) || h.duty !== 'idle') {
				task.note = t('Waiting for the hero');
				continue;
			}
			if (!spend()) return;
			const err = await run('realms.adventure', {
				hero: h.id,
				realm: task.realm,
				task: task.task,
				...(task.repeat ? { repeat: task.repeat } : {}),
			});
			const what = t('{0} to {1}: {2}', { 0: heroName(h), 1: game.t(realm.name), 2: game.t(realm.tasks[task.task].name) });
			if (err) {
				if (fail(queue, task, 'realms', `${what}: ${err}`)) return;
				continue;
			}
			started.add(h.id);
			queue.splice(queue.indexOf(task), 1);
			log('realms', true, t('Set out: {0}', { 0: what }));
		}
		for (const rule of data.realms.leveling.filter((r) => r.on)) {
			if (rule.stopAt && seen.now >= rule.stopAt) {
				stop(rule, t('Its time is up'));
				continue;
			}
			let busy = seen.heroes.filter((h) => matches(rule.heroes, h, { away: new Set(), injured: new Set() }) && s.away.has(h.id)).length;
			const why: string[] = [];
			const picked = chosen(rule.heroes, seen.heroes, s);
			if (!picked.length) why.push(t('No hero matches it'));
			for (const h of picked) {
				if (queued.has(h.id) || started.has(h.id)) continue;
				if (s.away.has(h.id)) {
					why.push(t('{0}: on an adventure', { 0: heroName(h) }));
					continue;
				}
				if (rule.stopAtLevel && h.level >= rule.stopAtLevel) {
					rule.heroes.exclude.push(h.id);
					log('realms', true, t('{0} reached level {1}: no more levelling', { 0: heroName(h), 1: rule.stopAtLevel }));
					continue;
				}
				if (s.injured.has(h.id)) {
					why.push(t('{0}: injured', { 0: heroName(h) }));
					if (rule.onInjury === 'stop') {
						rule.heroes.exclude.push(h.id);
						log('realms', false, t('{0} is injured: no more levelling', { 0: heroName(h) }));
					}
					continue;
				}
				if (h.duty !== 'idle' && !rule.leaveDuty) {
					why.push(t('{0}: in office', { 0: heroName(h) }));
					continue;
				}
				if (rule.heroes.max !== undefined && busy >= rule.heroes.max) {
					why.push(t('{0} heroes out already', { 0: busy }));
					break;
				}
				if (!canLeave(rule.heroes, h, seen.heroes, s)) {
					why.push(t('{0}: kept at home', { 0: heroName(h) }));
					continue;
				}
				const best = bestTask(rule, ov, h);
				if (!best) {
					why.push(t('{0}: no task safe enough', { 0: heroName(h) }));
					if (rule.noTask === 'stop') {
						rule.heroes.exclude.push(h.id);
						log('realms', false, t('{0}: no task safe enough, levelling stops', { 0: heroName(h) }));
					}
					continue;
				}
				if (!spend()) return;
				if (h.duty !== 'idle') {
					const err = await run('heroes.assign', { hero: h.id, duty: 'idle' });
					if (err) {
						log('realms', false, t('{0}: {1}', { 0: heroName(h), 1: err }));
						continue;
					}
					if (!spend()) return;
				}
				const err = await run('realms.adventure', {
					hero: h.id,
					realm: best.realm,
					task: best.task,
					...(rule.repeat ? { repeat: rule.repeat } : {}),
				});
				const realm = ov.realms.find((r) => r.id === best.realm)!;
				const what = t('{0} to {1}: {2}', { 0: heroName(h), 1: game.t(realm.name), 2: game.t(realm.tasks[best.task].name) });
				if (err) log('realms', false, `${what}: ${err}`);
				else {
					busy++;
					started.add(h.id);
					log('realms', true, t('Levelling: {0}', { 0: what }));
				}
			}
			rule.note = why.length ? why.join(t('; ')) : undefined;
		}
	}
	/** The task giving the most experience (an hour, or a run) that the hero clears safely enough. */
	function bestTask(rule: LevelRule, ov: RealmsOverview, h: HeroInfo) {
		const stats = ov.heroStats[h.id];
		if (!stats) return null;
		const least = rule.tier === 'easy' ? ov.outlook.easy : ov.outlook.even;
		let best: { realm: string; task: number; score: number } | null = null;
		for (const realm of ov.realms) {
			if (!realm.unlocked || (rule.realms.length && !rule.realms.includes(realm.id))) continue;
			realm.tasks.forEach((task, i) => {
				if (rule.exclude.includes(`${realm.id}/${i}`) || (rule.clearedOnly && !task.cleared)) return;
				if (margin(stats, task.groups, ov.minDamage) < least) return;
				const exp = task.exp.reduce((a, b) => a + b, 0);
				const score = rule.by === 'perRun' ? exp : exp / Math.max(1, task.groups.length * ov.groupSeconds);
				if (!best || score > best.score) best = { realm: realm.id, task: i, score };
			});
		}
		return best as { realm: string; task: number } | null;
	}
	function stop(rule: LevelRule | CampRule, why: string) {
		rule.on = false;
		rule.stopped = why;
		log('force' in rule ? 'camps' : 'realms', true, t('"{0}" stopped: {1}', { 0: rule.name, 1: why }));
		flag(t('"{0}" stopped', { 0: rule.name }));
	}

	/* ----- raiding camps (gameplay.md §15.4) ----------------------------------------------- */

	function citiesOf(pick: CampRule['from'], mine: SettlementSummary[]) {
		return mine.filter((s) => pick.all || pick.ids.includes(s.id) || pick.kinds.includes(s.kind));
	}
	async function camps(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const mine = (game.view('settlements.mine') ?? []) as SettlementSummary[];
		const garrisons = game.static<Garrisons>('npc-camps.garrisons') ?? {};
		const s = heroState(seen);
		const away = new Set(seen.armies.filter((a) => a.mission === 'attack').map((a) => `${a.target.x},${a.target.y}`));
		for (const a of seen.armies) due(a.phase === 'outbound' ? a.arrivesAt : a.returnsAt);
		for (const rule of data.camps.rules.filter((r) => r.on)) {
			// Its marches: reports counted once (losses, the run of defeats), marches back home forgotten.
			for (const id of [...rule.marches]) {
				const army = seen.armies.find((a) => a.id === id);
				if (!army) {
					rule.marches.splice(rule.marches.indexOf(id), 1);
					continue;
				}
				if (army.report && army.phase === 'returning' && !counted.has(id)) {
					counted.add(id);
					rule.lost += Object.values(army.report.losses.attacker).reduce((a, b) => a + b, 0);
					rule.streak = army.report.outcome === 'victory' ? 0 : rule.streak + 1;
				}
			}
			const stopWhy =
				rule.stopAt && seen.now >= rule.stopAt
					? t('Its time is up')
					: rule.stopTimes && rule.sent >= rule.stopTimes
						? t('Sent {0} times', { 0: rule.sent })
						: rule.stopLosses && rule.lost >= rule.stopLosses
							? t('{0} units lost', { 0: rule.lost })
							: rule.stopLossStreak && rule.streak >= rule.stopLossStreak
								? t('{0} defeats in a row', { 0: rule.streak })
								: null;
			if (stopWhy) {
				stop(rule, stopWhy);
				continue;
			}
			for (const origin of citiesOf(rule.from, mine)) {
				// One party of a rule out from a settlement at a time.
				if (seen.armies.some((a) => rule.marches.includes(a.id) && a.from === origin.id)) continue;
				const garrison = seen.garrisons.find((g) => g.settlement === origin.id);
				if (!garrison?.allowed) continue;
				const have = Object.fromEntries(garrison.units.map((u) => [u.id, u.count]));
				const size = Object.values(have).reduce((a, b) => a + b, 0);
				if (rule.stopGarrisonBelow !== undefined && size < rule.stopGarrisonBelow) {
					stop(rule, t('{0} has fewer than {1} units', { 0: game.t(origin.name), 1: rule.stopGarrisonBelow }));
					break;
				}
				const near = (seen.nearby[origin.id]?.settlements ?? []).filter(
					(c) =>
						c.npc &&
						!away.has(`${c.x},${c.y}`) &&
						// By the garrison: only camps whose garrison is known (other NPC places are left alone).
						(rule.force === 'fixed' || !!garrisons[c.kind]?.[String(c.level ?? 1)]) &&
						c.distance <= rule.distance &&
						(rule.targets.length
							? rule.targets.includes(c.settlement)
							: (!rule.kinds.length || rule.kinds.includes(c.kind)) &&
								(rule.levelMin === undefined || (c.level ?? 1) >= rule.levelMin) &&
								(rule.levelMax === undefined || (c.level ?? 1) <= rule.levelMax)),
				);
				if (!near.length) {
					if (rule.stopNoTarget) {
						stop(rule, t('No camp to raid'));
						break;
					}
					continue;
				}
				const target =
					rule.pick === 'highest'
						? [...near].sort((a, b) => (b.level ?? 1) - (a.level ?? 1) || a.distance - b.distance)[0]
						: rule.pick === 'random'
							? near[Math.floor(Math.random() * near.length)]
							: near[0];
				const force = forceOf(rule, target.kind, target.level ?? 1, have, garrisons);
				const where = t('{0} → {1} ({2}, {3})', { 0: game.t(origin.name), 1: game.t(target.name), 2: target.x, 3: target.y });
				if (typeof force === 'string') {
					if (rule.onFail === 'cancel') stop(rule, `${where}: ${force}`);
					else log('camps', false, `${where}: ${force}`);
					if (rule.onFail === 'block') break;
					continue;
				}
				let heroes: string[] = [];
				if (rule.hero) {
					const h = chosen(rule.hero, seen.heroes, s).find(
						(x) =>
							x.home === origin.id &&
							x.duty === 'idle' &&
							!s.away.has(x.id) &&
							!s.injured.has(x.id) &&
							canLeave(rule.hero!, x, seen.heroes, s),
					);
					if (h) heroes = [h.id];
					else if (rule.heroMissing === 'fail') {
						log('camps', false, t('{0}: no hero to lead it', { 0: where }));
						continue;
					}
				}
				if (!spend()) return;
				const err = await run('armies.send', {
					from: origin.id,
					x: target.x,
					y: target.y,
					mission: 'attack',
					units: force,
					formation: lanesOf(rule, force),
					...(heroes.length ? { heroes } : {}),
				});
				if (err) {
					log('camps', false, `${where}: ${err}`);
					if (rule.onFail === 'cancel') stop(rule, err);
					if (rule.onFail === 'block') break;
					continue;
				}
				rule.sent++;
				away.add(`${target.x},${target.y}`);
				pending.push({ rule: rule.id, from: origin.id, x: target.x, y: target.y });
				log('camps', true, t('Raid sent: {0}', { 0: where }));
			}
		}
		// Marches sent last time: found in this list by origin and target, then followed by id.
		for (const p of pending.splice(0)) {
			const army = seen.armies.find((a) => a.from === p.from && a.target.x === p.x && a.target.y === p.y && a.mission === 'attack');
			const rule = data.camps.rules.find((r) => r.id === p.rule);
			if (army && rule && !rule.marches.includes(army.id)) rule.marches.push(army.id);
			else if (!army) pending.push(p);
		}
	}
	const counted = new Set<string>();
	const pending: { rule: string; from: string; x: number; y: number }[] = [];

	/** What to send: the player's numbers, or the camp's garrison (by tier) x the factor, families as the garrison has them. */
	function forceOf(
		rule: CampRule,
		kind: string,
		level: number,
		have: Record<string, number>,
		garrisons: Garrisons,
	): Record<string, number> | string {
		if (rule.force === 'fixed') {
			for (const [u, n] of Object.entries(rule.fixed)) if ((have[u] ?? 0) < n) return t('Not enough troops');
			const out = Object.fromEntries(Object.entries(rule.fixed).filter(([, n]) => n > 0));
			return Object.keys(out).length ? out : t('No troops set');
		}
		const lane = garrisons[kind]?.[String(level)]?.lane;
		if (!lane) return t('No garrison known for that camp');
		const units = game.meta.units ?? [];
		const out: Record<string, number> = {};
		for (const [tier, perLane] of Object.entries(lane)) {
			const need = Math.ceil(perLane * LANES * rule.factor);
			if (need <= 0) continue;
			// This tier's units here, by family, shared as the garrison has them.
			const mine = units.filter((u) => u.tier === Number(tier) && u.family && (have[u.id] ?? 0) > 0);
			const pool = mine.reduce((a, u) => a + have[u.id], 0);
			if (pool < need) return t('Not enough tier {0} units ({1} of {2})', { 0: tier, 1: pool, 2: need });
			let left = need;
			mine.forEach((u, i) => {
				const n = i === mine.length - 1 ? left : Math.min(left, Math.round((need * have[u.id]) / pool));
				if (n > 0) out[u.id] = n;
				left -= n;
			});
		}
		return Object.keys(out).length ? out : t('No troops set');
	}
	/** Five lanes: families on lanes by their numbers (three lanes or all five), each family's units split over its lanes. */
	function lanesOf(rule: CampRule, force: Record<string, number>) {
		const units = game.meta.units ?? [];
		const familyOf = (u: string) => units.find((x) => x.id === u)?.family;
		const byFamily = new Map<string, Record<string, number>>();
		for (const [u, n] of Object.entries(force)) {
			const f = familyOf(u);
			if (!f) continue;
			byFamily.set(f, { ...(byFamily.get(f) ?? {}), [u]: n });
		}
		const families = [...byFamily.keys()];
		if (!families.length) return undefined;
		const used = rule.formation === 'three' ? Math.min(3, LANES) : LANES;
		const sizes = families.map((f) => Object.values(byFamily.get(f)!).reduce((a, b) => a + b, 0));
		const all = sizes.reduce((a, b) => a + b, 0);
		// Lanes by share (largest remainder), every family present at least one.
		const count = families.map((_, i) => Math.max(1, Math.floor((used * sizes[i]) / all)));
		while (count.reduce((a, b) => a + b, 0) > used) count[count.indexOf(Math.max(...count))]--;
		while (count.reduce((a, b) => a + b, 0) < used) {
			const gap = families.map((_, i) => (used * sizes[i]) / all - count[i]);
			count[gap.indexOf(Math.max(...gap))]++;
		}
		const lanes: { family: string; units: Record<string, number> }[] = [];
		families.forEach((f, i) => {
			const n = count[i];
			for (let k = 0; k < n; k++) {
				const share: Record<string, number> = {};
				for (const [u, c] of Object.entries(byFamily.get(f)!)) share[u] = Math.floor(c / n) + (k < c % n ? 1 : 0);
				lanes.push({ family: f, units: share });
			}
		});
		// The lanes left (three-lane push): empty, of the largest family.
		const main = families[sizes.indexOf(Math.max(...sizes))];
		while (lanes.length < LANES) lanes.push({ family: main, units: {} });
		if (rule.shuffle)
			for (let i = lanes.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[lanes[i], lanes[j]] = [lanes[j], lanes[i]];
			}
		return lanes;
	}

	return { scanNow: () => (running ? Promise.resolve() : scan()), settings };
}

export type RealmTaskRef = RealmTask;
export type BuildTaskRef = BuildTask;
