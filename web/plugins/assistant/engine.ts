// The assistant at work (docs/design/gameplay.md §15): a secretary in the browser. It judges only from the player's data
// the browser already holds (the store: game.data, filled by the pages' syncs; user 2026-10-24: "小助手只是前端秘书，如果想
// 小助手帮忙处理其他城池，就玩家手动切一下其他城市"), never asking the server for anything of its own, and sends the commands
// a player would, as a click does (the page shown refreshes with the answer). It looks again when something it waits for falls due, or
// every few minutes. Every command is checked by the server as usual: a refusal is logged, the task waits a while.
import { watch } from 'vue';
import type {
	ArmyInfo,
	BuildingsState,
	EquipmentItems,
	HeroInfo,
	MapWindow,
	NearbyOverview,
	NpcCampLevels,
	RealmsInfo,
	ResearchJob,
	ResearchState,
	ResourcePool,
	SettlementSummary,
	TroopsState,
	UnitCatalog,
} from '../../../src/shared/api';
import { type BuildingCatalog, levelCost } from '../../../src/shared/buildings';
import { nameKey } from '../../../src/shared/heroes';
import { type HeroStatsTable, margin } from '../../../src/shared/realms';
import type { HeroEffectsStatic } from '../../../src/shared/starter-heroes';
import { type ResearchCatalog, type TechPlan, techQuote } from '../../../src/shared/research';
import type { CardsData, TreeData } from '../../../src/shared/ui';
import type { Game } from '../../core/game';
import { campLanes, laneTotals } from './camp-force';
import { slotList } from './slots';
import { outfit, type OutfitHero, type OutfitPiece } from './outfit';
import { planResearch, problemText, stepKey } from './research-plan';
import type { CampRule, HeroPick, LevelRule, PointRule, Policy, ResearchTarget, Store } from './store';
import { uid } from './store';

export interface AssistantSettings {
	enabled: boolean;
	commandsPerScan: number;
}

/** Each lane of an NPC camp, by tier, for a kind and level (the static `npc-camps.levels` the map also reads). */
type Garrisons = Record<string, Record<string, Pick<NpcCampLevels[string][string], 'lane'>>>;

const LANES = 5;
/** Looking again without anything due: this often (a sync alone is no reason). */
const SCAN_EVERY = 5 * 60_000;
/** A command the server refused is not tried again before this. */
const RETRY = 5 * 60_000;

interface Seen {
	states: Record<string, BuildingsState | null>;
	pools: Record<string, ResourcePool | null>;
	/** The research part, by settlement (each with that settlement as `here`). */
	research: Record<string, ResearchState | null>;
	heroes: HeroInfo[];
	realms: RealmsInfo | null;
	/** Only the settlements that can hold troops (the Army page's). */
	garrisons: TroopsState['garrisons'];
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
	/** What it told the player to open (once a session each: a settlement, a map around one). */
	const asked = new Set<string>();
	/** Tasks and rules refused by the server, by id: not before this time. */
	const retryAt = new Map<string, number>();

	watch(
		() => game.state.value,
		() => {
			if (running || !settings()?.enabled || !data.on) return;
			const due = game.serverNow() >= dueAt;
			if (Date.now() - lastScan < SCAN_EVERY && !due) return;
			void scan();
		},
	);

	async function scan() {
		running = true;
		lastScan = Date.now();
		dueAt = Infinity;
		try {
			const seen = gather();
			if (!seen) return;
			let budget = settings()?.commandsPerScan ?? 5;
			const spend = () => budget-- > 0;
			// As a click: the page shown is refreshed by the answer; a refusal comes back as text, without a toast.
			const run = (type: string, payload: unknown) => game.tryCommand(type, payload);
			// Heroes back from an adventure (away the last look, free now): their groups share out again.
			if (data.equip.on && data.equip.when.afterAdventure) {
				const back = seen.heroes.filter((h) => wasAway.has(h.id) && isFree(h)).map((h) => h.home);
				if (back.length) await steward([...new Set(back)], run);
			}
			wasAway = new Set(seen.heroes.filter((h) => !isFree(h)).map((h) => h.id));
			if (data.points.on) await points(seen, spend, run);
			if (data.realms.on) await realms(seen, spend, run);
			if (data.build.on) await build(seen, spend, run);
			if (data.research.on) await research(seen, spend, run);
			if (data.camps.on) await camps(seen, spend, run);
			if (dueAt < Infinity) game.refreshAt(dueAt + 1_000);
		} catch (err) {
			log('assistant', false, t('The assistant could not look: {0}', { 0: err instanceof Error ? err.message : String(err) }));
		} finally {
			running = false;
		}
	}
	/* ----- the equipment steward (user 2026-11-08: "小助手新增'装备'功能") ------------------------- */

	/** Heroes away at the last look (an adventure, an army…): back when free again. */
	let wasAway = new Set<string>();
	/** Whether a hero may change what it wears (its duty one the player may change at will: idle, posts…). */
	const isFree = (h: HeroInfo) => !!game.meta.heroes?.duties.find((d) => d.id === h.duty)?.manual;
	/**
	 * Each group of these settlements shares out its pieces (./outfit.ts) and the moves are made: from what the browser
	 * holds (the settlement's equipment as the Heroes page synced it, the roster, the baked tables); none of it asked
	 * of the server for the assistant.
	 */
	async function steward(settlements: string[], run: (type: string, payload: unknown) => Promise<string | null>) {
		const meta = game.meta.equipment;
		if (!meta) return;
		const bases = new Map(meta.bases.map((b) => [b.id, b]));
		const groupOf = new Map(meta.slots.map((s) => [s.id, s.group]));
		const tables = {
			adventure: game.static<HeroStatsTable>('starter-realms.heroStats'),
			effects: game.static<HeroEffectsStatic>('starter-heroes.effects'),
		};
		const roster = game.compute<HeroInfo[]>('heroes.roster', {}) ?? [];
		const mine = game.data<SettlementSummary[]>('settlements.mine') ?? [];
		for (const id of settlements) {
			const items = game
				.held<EquipmentItems | null>('equipment.items')
				.filter((x) => x.value?.settlement === id)
				.sort((a, b) => b.at - a.at)[0]?.value;
			const name = game.t(mine.find((s) => s.id === id)?.name ?? id);
			if (!items) {
				ask(`equip:${id}`, t('Open the Heroes page with {0} picked once for the assistant to see its equipment', { 0: name }));
				continue;
			}
			// Acted on already: what it holds is from before those steps; the next sync that brings the list plans again.
			if (acted.has(items)) continue;
			const here = roster.filter((h) => h.home === id && isFree(h));
			const made = data.equip.groups.filter((g) => g.settlement === id);
			const inMade = new Set(made.flatMap((g) => g.heroes));
			const order = data.equip.order[id] ?? [];
			const rest = here.filter((h) => !inMade.has(h.id)).sort((a, b) => rank(order, a.id) - rank(order, b.id));
			const groups = [rest, ...made.map((g) => g.heroes.flatMap((hid) => here.filter((h) => h.id === hid)))];
			for (const list of groups) {
				if (!list.some((h) => data.equip.wants[h.id]?.length)) continue;
				const heroes: OutfitHero[] = list.map((h) => ({
					id: h.id,
					level: h.level,
					gender: h.gender,
					attrs: h.attrs,
					accessories: items.heroes.find((x) => x.id === h.id)?.accessories ?? 0,
				}));
				const ids = new Set(heroes.map((h) => h.id));
				const pool: OutfitPiece[] = items.pieces
					.filter((p) => p.hero === null || ids.has(p.hero))
					.map((p) => {
						const b = bases.get(p.base);
						const slot = b?.slot ?? '';
						return { id: p.id, slot, group: groupOf.get(slot), minLevel: b?.minLevel ?? 0, stats: p.stats, hero: p.hero };
					});
				const room = { stored: items.pieces.filter((p) => p.hero === null).length, capacity: items.capacity };
				// Worked out once for what the browser holds (the list, the heroes, the setup): the same again plans nothing anew.
				const key = JSON.stringify([heroes, list.map((h) => data.equip.wants[h.id] ?? []), room]);
				let planned = outfits.get(items)?.get(key);
				if (!planned) {
					planned = outfit(heroes, pool, (hid) => data.equip.wants[hid] ?? [], tables, room);
					if (!outfits.has(items)) outfits.set(items, new Map());
					outfits.get(items)!.set(key, planned);
				}
				const nameOf = (pieceId: string) => {
					const piece = items.pieces.find((p) => p.id === pieceId)!;
					return game.t(bases.get(piece.base)?.name ?? piece.base);
				};
				if (planned.steps.length) acted.add(items);
				for (const m of planned.steps) {
					const hero = m.hero ? list.find((h) => h.id === m.hero)! : null;
					const what = hero
						? t('{0} puts on {1}', { 0: heroName(hero), 1: nameOf(m.piece) })
						: t('{0} goes into storage', { 0: nameOf(m.piece) });
					const err = hero
						? await run('equipment.equip', { piece: m.piece, hero: m.hero })
						: await run('equipment.unequip', { piece: m.piece });
					log('equip', !err, err ? t('{0}: {1}', { 0: what, 1: err }) : what);
					if (err) break; // what the browser holds is no longer so: the next sync plans again
				}
				if (planned.skipped.length)
					log('equip', false, t('No room in storage to swap: {0}', { 0: planned.skipped.map(nameOf).join(game.t(', ')) }));
			}
		}
	}
	/** Plans by the equipment list the browser holds (a new list on every sync that brings one), then by the rest. */
	const outfits = new WeakMap<EquipmentItems, Map<string, ReturnType<typeof outfit>>>();
	const acted = new WeakSet<EquipmentItems>();
	const rank = (order: string[], id: string) => (order.includes(id) ? order.indexOf(id) : order.length + 1);

	const due = (at: number) => (dueAt = Math.min(dueAt, at));
	const refused = (id: string) => retryAt.set(id, Date.now() + RETRY);
	const waitingRetry = (id: string) => (retryAt.get(id) ?? 0) > Date.now();

	/* ----- what it needs: from the store only (what the pages synced) ----------------------------- */

	/** Once a session: what the player should open for the assistant to see it. */
	const ask = (key: string, text: string) => {
		if (asked.has(key)) return;
		asked.add(key);
		log('assistant', false, text);
	};

	function gather(): Seen | null {
		const mine = game.data<SettlementSummary[]>('settlements.mine') ?? [];
		const cities = new Set(data.build.on ? data.build.tasks.map((x) => x.settlement) : []);
		// Research: the settlements a target names, or all for "any with an institute free".
		const labs = new Set(
			data.research.on ? data.research.targets.flatMap((x) => (x.settlement ? [x.settlement] : mine.map((s) => s.id))) : [],
		);
		const leveling = data.realms.on && (data.realms.queue.length > 0 || data.realms.leveling.some((r) => r.on));
		const pointing = data.points.on && data.points.rules.some((r) => r.on);
		const raiding = data.camps.on && data.camps.rules.some((r) => r.on);
		const equipping = data.equip.on && data.equip.when.afterAdventure && Object.values(data.equip.wants).some((w) => w.length);
		if (!cities.size && !labs.size && !leveling && !pointing && !raiding && !equipping) return null;
		const name = (id: string) => game.t(mine.find((s) => s.id === id)?.name ?? id);
		for (const id of cities)
			if (!game.data('buildings.state', { settlement: id }))
				ask(`city:${id}`, t('Open {0} once (switch to it) for the assistant to see its buildings', { 0: name(id) }));
		const nearby: Record<string, NearbyOverview> = {};
		if (raiding) {
			// The camps around a settlement, from the map window the player last saw around it (worked out here: the rule
			// camps come from the rules; user 2026-10-22: "小助手只能用前端数据").
			const windows = game.held<MapWindow>('world-map.window').sort((a, b) => b.at - a.at);
			for (const rule of data.camps.rules.filter((r) => r.on))
				for (const s of citiesOf(rule.from, mine)) {
					if (nearby[s.id]) continue;
					const w = windows.find((x) => x.value?.centre.x === s.x && x.value?.centre.y === s.y);
					if (w) nearby[s.id] = game.compute<NearbyOverview>('settlements.nearby', w.params) ?? { maxRadius: 0, settlements: [] };
					else ask(`map:${s.id}`, t('Look at the map around {0} once for the assistant to see the camps there', { 0: name(s.id) }));
				}
		}
		const by = <T>(view: string, ids: Iterable<string>) =>
			Object.fromEntries([...ids].map((id) => [id, game.data<T>(view, { settlement: id }) ?? null]));
		return {
			states: by<BuildingsState | null>('buildings.state', cities),
			pools: by<ResourcePool | null>('resources.pool', new Set([...cities, ...labs])),
			research: by<ResearchState | null>('research.state', labs),
			heroes: game.compute<HeroInfo[]>('heroes.roster', {}) ?? [],
			realms: game.compute<RealmsInfo | null>('realms.info', {}) ?? null,
			garrisons: game.data<TroopsState>('troops.state', {})?.garrisons ?? [],
			armies: game.data<ArmyInfo[]>('armies.list', {}) ?? [],
			nearby,
			now: game.serverNow(),
		};
	}

	/** What happens to a task that cannot go ahead (gameplay.md §15.5): true when the rest of its queue must wait. */
	function fail<T extends { id: string; onFail: Policy; note?: string }>(
		list: T[],
		task: T,
		area: 'build' | 'research' | 'realms',
		why: string,
	) {
		task.note = why;
		if (task.onFail === 'cancel') {
			list.splice(list.indexOf(task), 1);
			log(area, false, t('Removed from the queue: {0}', { 0: why }));
			return false;
		}
		if (task.onFail === 'block') {
			log(area, false, t('The queue waits: {0}', { 0: why }));
			flag(
				area === 'build'
					? t('The building queue is blocked')
					: area === 'research'
						? t('The research queue is blocked')
						: t('The adventure queue is blocked'),
			);
			return true;
		}
		log(area, false, t('Skipped for now: {0}', { 0: why }));
		return false;
	}

	/* ----- building queue (gameplay.md §15.2) ---------------------------------------------- */

	const buildingName = (id: string) => game.t(game.meta.buildings?.find((b) => b.id === id)?.name ?? id);
	/**
	 * Constructions this session's assistant ordered, by "settlement|district|slot", with when (the browser's clock, as
	 * what it holds is stamped): under way until a sync of that settlement's `buildings.state` after it brings them.
	 */
	const ordered = new Map<string, { settlement: string; construction: BuildingsState['construction'][number]; at: number }>();
	/**
	 * A settlement's buildings as of now, from the latest the browser holds (the City page's syncs: switching through
	 * the settlements once after a reload is all it takes), carried forward here without a new sync (user 2026-11-05:
	 * "前端不会没记施工中任务的预计完成时间吧？"): what it ordered itself is under way, a construction past its end is
	 * built (its level reached, its place in the queue free). A copy: what the browser holds stays as synced.
	 */
	function buildingsNow(settlement: string, now: number, catalog: BuildingCatalog): BuildingsState | null | undefined {
		const held = game
			.held<BuildingsState | null>('buildings.state')
			.filter((x) => x.value?.settlement.id === settlement)
			.sort((a, b) => b.at - a.at)[0];
		if (!held?.value) return held ? null : undefined;
		// (A plain copy: what the store holds is reactive, which structuredClone refuses.)
		const st = JSON.parse(JSON.stringify(held.value)) as BuildingsState;
		for (const [key, o] of ordered) {
			if (o.settlement !== settlement) continue;
			if (o.at <= held.at)
				ordered.delete(key); // the synced part has it now
			else if (!st.construction.some((c) => c.district === o.construction.district && c.slot === o.construction.slot)) {
				st.construction.push(o.construction);
				st.queue.used++;
			}
		}
		for (const c of [...st.construction])
			if (c.finishesAt <= now) {
				const slot = st.slots.find((x) => x.district === c.district && x.slot === c.slot);
				if (slot) slot.level = Math.max(slot.level, c.targetLevel);
				else
					st.slots.push({
						district: c.district,
						slot: c.slot,
						building: c.building,
						level: c.targetLevel,
						cap: catalog.buildings[c.building]?.cap ?? c.targetLevel,
					});
				st.construction.splice(st.construction.indexOf(c), 1);
				st.queue.used = Math.max(0, st.queue.used - 1);
			}
		return st;
	}
	/**
	 * An institute (any building giving research labs) for this settlement in the building queue, unless one stands, is
	 * being built or is queued there: in its first empty slot that may hold one, level 1. What to note, or null (it cannot).
	 */
	function queueLab(settlement: string | undefined, seen: Seen): string | null {
		const cards = game.static<CardsData>('buildings.catalog');
		const catalog = cards?.data as BuildingCatalog | undefined;
		if (!settlement || !catalog) return null;
		const labs = Object.entries(catalog.buildings)
			.filter(([, p]) => (p.stats?.['research.labs'] ?? 0) > 0)
			.map(([id]) => id);
		if (data.build.tasks.some((x) => x.settlement === settlement && labs.includes(x.building)))
			return t('Waiting: an institute is in the building queue');
		const st = buildingsNow(settlement, seen.now, catalog);
		if (!st) {
			ask(`city:${settlement}`, t('Open {0} once (switch to it) for the assistant to see its buildings', { 0: placeName(settlement) }));
			return null;
		}
		const slots = slotList(st, cards);
		if (slots.some((s) => labs.includes(s.current?.building ?? '') || labs.includes(s.building?.building ?? '')))
			return t('Waiting: the institute is being built');
		const free = slots.find((s) => !s.current && s.options.some((b) => labs.includes(b)));
		if (!free) return null;
		const building = free.options.find((b) => labs.includes(b))!;
		data.build.tasks.push({ id: uid(), settlement, district: free.district, slot: free.slot, building, level: 1, onFail: 'block' });
		log('research', true, t('{0} put in the building queue at {1} for research', { 0: buildingName(building), 1: placeName(settlement) }));
		return t('Waiting: an institute is in the building queue');
	}
	const placeName = (id: string) => game.t((game.data<SettlementSummary[]>('settlements.mine') ?? []).find((s) => s.id === id)?.name ?? id);
	const mineIds = () => (game.data<SettlementSummary[]>('settlements.mine') ?? []).map((s) => s.id);
	async function build(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const catalog = game.static<CardsData>('buildings.catalog')?.data as BuildingCatalog | undefined;
		if (!catalog) return;
		const tasks = data.build.tasks;
		const states = new Map<string, BuildingsState | null | undefined>();
		const stateOf = (id: string) => (states.has(id) ? states.get(id) : states.set(id, buildingsNow(id, seen.now, catalog)).get(id));
		const waiting = new Set<string>(); // settlements whose earlier task waits: later ones there wait too (in order)
		for (const task of [...tasks]) {
			if (!tasks.includes(task)) continue;
			const st = stateOf(task.settlement);
			if (st === undefined) continue; // not fetched (yet): the player is asked once to look at it
			if (!st) {
				// Not held is not gone: gone only when it is no longer the player's.
				if (mineIds().includes(task.settlement)) continue;
				if (fail(tasks, task, 'build', t('That settlement is gone'))) return;
				continue;
			}
			const what = t('{0} Lv {1} in {2}', { 0: buildingName(task.building), 1: task.level, 2: game.t(st.settlement.name) });
			const district = st.settlement.districts.find((x) => x.id === task.district);
			if (!district || task.slot >= district.slots) {
				if (fail(tasks, task, 'build', t('No such slot: {0}', { 0: what }))) return;
				continue;
			}
			const cur = st.slots.find((x) => x.district === task.district && x.slot === task.slot);
			const cons = st.construction.find((x) => x.district === task.district && x.slot === task.slot);
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
			if (waiting.has(st.settlement.id)) {
				task.note = t('Waiting for the task before');
				continue;
			}
			if (st.queue.used >= st.queue.size) {
				task.note = t('Waiting: the construction slots are taken');
				waiting.add(st.settlement.id);
				continue;
			}
			const plan = catalog.buildings[task.building];
			if (!plan || task.level > (cur?.cap ?? plan.cap)) {
				if (fail(tasks, task, 'build', t('Cannot be built there: {0}', { 0: what }))) return;
				continue;
			}
			if (waitingRetry(task.id)) {
				waiting.add(st.settlement.id);
				continue;
			}
			// The price as the server quotes it (the same shared code; buildings get no per-player discount), the time
			// with this settlement's factor.
			const quote = levelCost(plan, task.level, catalog);
			const short = shortOf(seen, st.settlement.id, quote.cost);
			if (short) {
				task.note = t('Waiting for {0}', { 0: short });
				waiting.add(st.settlement.id);
				continue;
			}
			if (!spend()) return;
			const err = await run('buildings.construct', {
				settlement: st.settlement.id,
				district: task.district,
				slot: task.slot,
				building: task.building,
			});
			if (err) {
				refused(task.id);
				waiting.add(st.settlement.id);
				if (fail(tasks, task, 'build', t('{0}: {1}', { 0: what, 1: err }))) return;
				continue;
			}
			task.note = t('Started');
			log('build', true, t('Started: {0}', { 0: what }));
			// What this look knows now: the place taken, the stock spent, when it is done; remembered for the next looks
			// until a sync brings it (the City page need not be open).
			const seconds = Math.ceil(quote.seconds * st.time.factor);
			const construction = {
				district: task.district,
				slot: task.slot,
				building: task.building,
				targetLevel: task.level,
				startedAt: seen.now,
				finishesAt: seen.now + seconds * 1000,
			};
			st.queue.used++;
			st.construction.push(construction);
			ordered.set(`${st.settlement.id}|${task.district}|${task.slot}`, { settlement: st.settlement.id, construction, at: Date.now() });
			due(seen.now + seconds * 1000);
			const pool = seen.pools[st.settlement.id];
			if (pool) for (const [r, n] of Object.entries(quote.cost)) pool.amounts[r] = (pool.amounts[r] ?? 0) - n;
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
			if (have - keep < n) {
				// When it will be there at this rate: look again then.
				const rate = pool.rates[r] ?? 0;
				if (rate > 0) due(seen.now + ((n + keep - have) / rate) * 1000);
				return game.t(game.meta.resources?.find((x) => x.id === r)?.name ?? r);
			}
		}
		return null;
	}

	/* ----- research queue (gameplay.md §15.2.1) -------------------------------------------- */

	const techNameOf = (plans: ReadonlyMap<string, TechPlan>, id: string) => game.t(plans.get(id)?.name ?? id);
	/**
	 * Research this session's assistant started, by tech, with when (the browser's clock, as what it holds is stamped):
	 * under way until a sync of `research.state` after it brings it.
	 */
	const started = new Map<string, { job: ResearchJob; at: number }>();
	async function research(seen: Seen, spend: () => boolean, run: (type: string, payload: unknown) => Promise<string | null>) {
		const catalog = game.static<TreeData>('research.techs')?.data as ResearchCatalog | undefined;
		if (!catalog) return;
		// Levels and what is under way are the player's (the same in each settlement's part): the latest the browser
		// holds, from the Tech page's syncs (switching through the settlements there once after a reload is all it takes),
		// carried forward here. The assistant asks for no data of its own (user 2026-11-05: "小助手不额外请求后端数据，只能
		// 用前端已有的数据…不能让用户反复去点…上一个科研结束后，本地的数据应该也能知道"): a research past its end is
		// done (its level reached, its institute free), and what it started itself is under way, without a new sync.
		const latest = game
			.held<ResearchState | null>('research.state')
			.filter((x): x is typeof x & { value: ResearchState } => !!x.value)
			.sort((a, b) => b.at - a.at)[0];
		if (!latest) return ask('research', t('Open the Tech page once for the assistant to see your research'));
		const any = latest.value;
		for (const [tech, s] of started) if (s.at <= latest.at) started.delete(tech); // the synced part has it now
		const jobs = new Map<string, ResearchJob & { name?: string }>(any.jobs.map((j) => [j.tech, j]));
		for (const [tech, s] of started) jobs.set(tech, s.job);
		const levels: Record<string, number> = { ...any.levels };
		for (const [tech, j] of jobs)
			if (j.finishesAt <= seen.now) {
				levels[tech] = Math.max(levels[tech] ?? 0, j.targetLevel);
				jobs.delete(tech);
			}
		const targets = data.research.targets;
		const plans = new Map<string, TechPlan>([...catalog.techs, ...(any.own ?? [])].map((x) => [x.id, x]));
		const researching = jobs;
		const busy = new Set([...jobs.values()].map((j) => j.settlement));
		for (const j of jobs.values()) due(j.finishesAt);
		const what = (tech: string, level: number) => t('{0} Lv {1}', { 0: techNameOf(plans, tech), 1: level });
		for (const target of [...targets])
			if ((levels[target.tech] ?? 0) >= target.level) {
				targets.splice(targets.indexOf(target), 1);
				log('research', true, t('Researched: {0}', { 0: what(target.tech, target.level) }));
			}
		for (const target of targets) {
			target.notes = {};
			target.note = undefined;
		}
		const { steps, problems } = planResearch(targets, plans, levels);
		/** Targets passed over in this look (skipped or cancelled): their later steps wait. */
		const passed = new Set<string>();
		/** Settlements whose institute an earlier step waits to use (for resources): later steps leave it to it. */
		const held = new Set<string>();
		const summaries = game.data<SettlementSummary[]>('settlements.mine') ?? [];
		const mine = summaries.map((s) => s.id);
		const settlementName = (id: string) => game.t(summaries.find((s) => s.id === id)?.name ?? id);
		const byId = new Map(targets.map((x) => [x.id, x]));
		const order = (x: ResearchTarget) => targets.indexOf(x);
		/** Every step after a blocked target's first waits: the queue stops there. */
		let blockedAt = Infinity;
		const failed = (target: ResearchTarget, why: string) => {
			passed.add(target.id);
			const at = order(target);
			if (fail(targets, target, 'research', why)) blockedAt = Math.min(blockedAt, at);
		};
		for (const target of [...targets])
			if (problems[target.id])
				failed(
					target,
					problemText(problems[target.id], (id) => techNameOf(plans, id), t),
				);
		for (const step of steps) {
			const target = byId.get(step.target);
			if (!target || !targets.includes(target)) continue;
			const key = stepKey(step);
			const note = (text: string) => ((target.notes ??= {})[key] = text);
			if (order(target) >= blockedAt || passed.has(target.id)) {
				note(t('Waiting for the step before'));
				continue;
			}
			const job = researching.get(step.tech);
			if (job) {
				const where = seen.research[job.settlement]?.here?.name ?? job.name;
				note(
					job.targetLevel >= step.level
						? where
							? t('Being researched in {0}', { 0: game.t(where) })
							: t('Being researched')
						: t('Waiting for the level before'),
				);
				continue;
			}
			if (step.level > (levels[step.tech] ?? 0) + 1) {
				note(t('Waiting for the level before'));
				continue;
			}
			const plan = plans.get(step.tech)!;
			const missing = Object.entries(plan.requires ?? {}).find(([req, n]) => (levels[req] ?? 0) < n);
			if (missing) {
				note(t('Waiting for {0}', { 0: what(missing[0], missing[1]) }));
				continue;
			}
			// Where: the settlement named, else any with an institute; one research at a time in each.
			if (target.settlement && !seen.research[target.settlement]) {
				// Not held is not gone: gone only when it is no longer the player's.
				if (!mine.includes(target.settlement)) failed(target, t('That settlement is gone'));
				else {
					note(t('Waiting: open the Tech page there once'));
					ask(
						`research:${target.settlement}`,
						t('Open the Tech page with {0} picked once for the assistant to see its institute', { 0: settlementName(target.settlement) }),
					);
				}
				continue;
			}
			const places = (target.settlement ? [target.settlement] : mine)
				.map((id) => seen.research[id]?.here)
				.filter((h): h is NonNullable<ResearchState['here']> => !!h && h.labs >= 1);
			// Settlements whose research part the browser does not hold: maybe an institute there, unseen.
			const unseen = target.settlement ? [] : mine.filter((id) => !seen.research[id]);
			if (!places.length && unseen.length) {
				note(t('Waiting: open the Tech page there once'));
				for (const id of unseen)
					ask(
						`research:${id}`,
						t('Open the Tech page with {0} picked once for the assistant to see its institute', { 0: settlementName(id) }),
					);
				continue;
			}
			if (!places.length) {
				// No institute: one put in the building queue when the player lets it (else theirs to build); a wait, not a failure.
				const queued = data.research.buildLab !== false && data.build.on ? queueLab(target.settlement || mine[0], seen) : null;
				note(
					queued ??
						(target.settlement ? t('Waiting: no institute there (build one)') : t('Waiting: no settlement has an institute (build one)')),
				);
				continue;
			}
			const free = places.filter((h) => !busy.has(h.id) && !held.has(h.id));
			if (!free.length) {
				note(t('Waiting: the institutes are busy'));
				continue;
			}
			// Other plugins' conditions (e.g. a discovery needed): a failure, as when starting it by hand.
			const open = free.filter((h) => !h.gates[step.tech]);
			if (!open.length) {
				failed(target, t('{0}: {1}', { 0: what(step.tech, step.level), 1: game.t(free[0].gates[step.tech]) }));
				continue;
			}
			if (waitingRetry(`${target.id}|${key}`)) continue;
			// The price as the server quotes it (the same shared code, this settlement's factors), after what is kept back.
			let pick: { here: (typeof open)[number]; seconds: number; cost: Record<string, number> } | null = null;
			let short: { what: string; id: string } | null = null;
			for (const here of open) {
				const f = here.factors.techs?.[step.tech] ?? here.factors;
				const quote = techQuote(plan, step.level, catalog, { labSpeed: here.labSpeed, costFactor: f.cost, timeFactor: f.time });
				const lacking = shortOf(seen, here.id, quote.cost);
				if (!lacking) {
					pick = { here, ...quote };
					break;
				}
				short ??= { what: lacking, id: here.id };
			}
			if (!pick) {
				note(t('Waiting for {0}', { 0: short!.what }));
				held.add(short!.id);
				continue;
			}
			if (!spend()) return;
			const label = t('{0} in {1}', { 0: what(step.tech, step.level), 1: game.t(pick.here.name) });
			const err = await run('research.start', { tech: step.tech, settlement: pick.here.id });
			if (err) {
				refused(`${target.id}|${key}`);
				held.add(pick.here.id);
				failed(target, t('{0}: {1}', { 0: label, 1: err }));
				continue;
			}
			note(t('Started'));
			log('research', true, t('Research started: {0}', { 0: label }));
			// What this look knows now: the institute taken, the stock spent, when it is done.
			const finishesAt = seen.now + pick.seconds * 1000;
			busy.add(pick.here.id);
			const begun = { settlement: pick.here.id, tech: step.tech, targetLevel: step.level, startedAt: seen.now, finishesAt };
			researching.set(step.tech, begun);
			// Remembered for the next looks until a sync brings it (the Tech page need not be open).
			started.set(step.tech, { job: begun, at: Date.now() });
			due(finishesAt);
			const pool = seen.pools[pick.here.id];
			if (pool) for (const [r, n] of Object.entries(pick.cost)) pool.amounts[r] = (pool.amounts[r] ?? 0) - n;
		}
		// Under each target: why its first step not started waits (or why it failed).
		for (const target of targets) {
			if (target.note) continue;
			const first = steps.find((x) => x.target === target.id && target.notes?.[stepKey(x)]);
			if (first) target.note = target.notes![stepKey(first)];
		}
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
								.map(([a, n]) => t('{0} +{1}', { 0: attrName(a), 1: n }))
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
			if (data.equip.on && data.equip.when.beforeRealms) await steward([h.home], run);
			const err = await run('realms.adventure', {
				hero: h.id,
				realm: task.realm,
				task: task.task,
				...(task.repeat ? { repeat: task.repeat } : {}),
			});
			const what = t('{0} to {1}: {2}', { 0: heroName(h), 1: game.t(realm.name), 2: game.t(realm.tasks[task.task].name) });
			if (err) {
				if (fail(queue, task, 'realms', t('{0}: {1}', { 0: what, 1: err }))) return;
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
					if (rule.restoreDuty !== false) (data.realms.offices ??= {})[h.id] = { duty: h.duty, target: h.dutyTarget };
					if (!spend()) return;
				}
				if (data.equip.on && data.equip.when.beforeRealms) await steward([h.home], run);
				const err = await run('realms.adventure', {
					hero: h.id,
					realm: best.realm,
					task: best.task,
					...(rule.repeat ? { repeat: rule.repeat } : {}),
				});
				const realm = ov.realms.find((r) => r.id === best.realm)!;
				const what = t('{0} to {1}: {2}', { 0: heroName(h), 1: game.t(realm.name), 2: game.t(realm.tasks[best.task].name) });
				if (err) log('realms', false, t('{0}: {1}', { 0: what, 1: err }));
				else {
					busy++;
					started.add(h.id);
					log('realms', true, t('Levelling: {0}', { 0: what }));
				}
			}
			rule.note = why.length ? why.join(t('; ')) : undefined;
		}
		// Back in office ("官复原职"): those levelling took out of it, home and not sent again; the player's say once it
		// changed their duty itself.
		const offices = data.realms.offices ?? {};
		for (const [id, office] of Object.entries(offices)) {
			const h = byId.get(id);
			if (!h || h.duty !== 'idle') {
				delete offices[id];
				continue;
			}
			if (s.away.has(id) || started.has(id) || queued.has(id)) continue;
			if (!spend()) return;
			const err = await run('heroes.assign', { hero: id, duty: office.duty, ...(office.target ? { target: office.target } : {}) });
			log('realms', !err, err ? t('{0} back in office: {1}', { 0: heroName(h), 1: err }) : t('{0} back in office', { 0: heroName(h) }));
			delete offices[id];
		}
	}
	/** The task giving the most experience (an hour, or a run) that the hero clears safely enough. */
	function bestTask(rule: LevelRule, ov: RealmsInfo, h: HeroInfo) {
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
		const garrisons = game.static<NpcCampLevels>('npc-camps.levels') ?? {};
		// Units' attack under the rules (to stand higher tiers in for lower ones): until it has loaded, raids by the garrison wait.
		const numbers = game.static<UnitCatalog>('troops.units');
		const attack = numbers && Object.fromEntries(Object.entries(numbers).map(([id, u]) => [id, u.attack]));
		// Asked for now so it is there when a report comes back (statics load on first use).
		game.static('npc-camps.refill');
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
					// The camp it beat now refills: worked out here from the rule (static), not read again from the server.
					const hours = game.static<{ hours: number }>('npc-camps.refill')?.hours ?? 0;
					if (army.report.outcome === 'victory' && hours > 0)
						refilling.set(`${army.target.x},${army.target.y}`, army.arrivesAt + hours * 3600_000);
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
				if (!garrison) continue;
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
						// Still refilling (less loot and captives) unless the rule says otherwise.
						(rule.skipRefilling === false || Math.max(c.fullAt ?? 0, refilling.get(`${c.x},${c.y}`) ?? 0) <= game.serverNow()) &&
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
				if (rule.force !== 'fixed' && !attack) continue;
				const force = planOf(rule, target.kind, target.level ?? 1, have, garrisons, attack);
				const where = t('{0} → {1} ({2}, {3})', { 0: game.t(origin.name), 1: game.t(target.name), 2: target.x, 3: target.y });
				if (typeof force === 'string') {
					if (rule.onFail === 'cancel') stop(rule, t('{0}: {1}', { 0: where, 1: force }));
					else log('camps', false, t('{0}: {1}', { 0: where, 1: force }));
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
				if (data.equip.on && data.equip.when.beforeCamps) await steward([origin.id], run);
				const err = await run('armies.send', {
					from: origin.id,
					x: target.x,
					y: target.y,
					mission: 'attack',
					units: force.units,
					formation: force.formation,
					...(heroes.length ? { heroes } : {}),
				});
				if (err) {
					log('camps', false, t('{0}: {1}', { 0: where, 1: err }));
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
	/** Camps this assistant beat, by tile: full again then (the nearby list is read at most every 30 minutes). */
	const refilling = new Map<string, number>();
	const pending: { rule: string; from: string; x: number; y: number }[] = [];

	/**
	 * What to send and how: the player's numbers (lanes by their families' shares, `lanesOf`), or every lane the
	 * camp's lane garrison × the factor, families at random where the troops allow (./camp-force.ts).
	 */
	function planOf(
		rule: CampRule,
		kind: string,
		level: number,
		have: Record<string, number>,
		garrisons: Garrisons,
		attack: Record<string, number> | undefined,
	): { units: Record<string, number>; formation: ReturnType<typeof lanesOf> } | string {
		if (rule.force === 'fixed') {
			for (const [u, n] of Object.entries(rule.fixed)) if ((have[u] ?? 0) < n) return t('Not enough troops');
			const units = Object.fromEntries(Object.entries(rule.fixed).filter(([, n]) => n > 0));
			return Object.keys(units).length ? { units, formation: lanesOf(rule, units) } : t('No troops set');
		}
		const lane = garrisons[kind]?.[String(level)]?.lane;
		if (!lane) return t('No garrison known for that camp');
		const count = rule.formation === 'three' ? Math.min(3, LANES) : LANES;
		if (!attack) return t('Loading…');
		const plan = campLanes({
			lane,
			factor: rule.factor,
			count,
			lanes: LANES,
			have,
			units: game.meta.units ?? [],
			attack,
			shuffle: rule.shuffle,
		});
		if (!plan) return t('Not enough troops for {0} lanes of {1} × the garrison', { 0: count, 1: rule.factor });
		return { units: laneTotals(plan), formation: plan };
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

	return {
		scanNow: () => (running ? Promise.resolve() : scan()),
		settings,
		/** "Now" (the equipment panel's button): these settlements' groups share out their pieces at once. */
		outfitNow: (settlements: string[]) => steward(settlements, (type, payload) => game.tryCommand(type, payload)),
	};
}
