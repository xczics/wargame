// The City page's slot cards (`buildings.slots`), assembled in the browser (AGENTS.md: the server sends data only) from
// the settlement's buildings (`buildings.state`) and the static catalog (`buildings.catalog`). Pure: the tests run it.
// One card per slot of the district chosen on the district board: which template it is (building and level), what is
// being built, what is unique and already there, the counters, and other plugins' lines for it (a wall's strength),
// worded by their client plugins from the numbers the server sent (./effects.ts).
import type { BuildingEffectPart, BuildingsState, SettlementKindMeta } from '../../../src/shared/api';
import {
	type BuildingCatalog,
	demolishQuote,
	districtLabel,
	effectTexts,
	levelEffects,
	ownUpgradeLines,
	QUEUE_COUNTER,
	slotsOf,
	TIME_COUNTER,
} from '../../../src/shared/buildings';
import { duration } from '../../../src/shared/format';
import { costVar, keyText, uiTexts } from '../../../src/shared/i18n';
import { breakdownTexts, speedTexts } from '../../../src/shared/stats';
import type { CardsData, UiAction, UiCard, UiLine, UiText } from '../../../src/shared/ui';
import { effectLines } from './effects';

// The buildings plugin's own words (its i18n keys): the cards read as they did when the server built them.
const text = uiTexts('buildings');

export function slotCards(
	state: BuildingsState | null | undefined,
	catalog: BuildingCatalog | undefined,
	/** The meta's settlement kinds: the header names the settlement's. */
	kinds?: readonly SettlementKindMeta[],
	/** Other client plugins' words for what their server plugins give buildings ("buildings.effects"). */
	parts?: ReadonlyMap<string, BuildingEffectPart>,
	/** The meta's resources: a demolition's refund named in its prompt. */
	resources: readonly { id: string; name: string; icon?: string }[] = [],
): CardsData | undefined {
	if (state === undefined) return undefined;
	if (state === null) return { cards: [], empty: text('You have no settlement yet'), placement: 'settlement' };
	const s = state.settlement;
	const plans = catalog?.buildings ?? {};
	const name = (id: string) => keyText(plans[id]?.name ?? id);
	const { slots, taken } = slotsOf(state, plans);

	// What is unique and already there (or being built), by district: off in its empty slots' lists.
	const blockedSets: Record<string, Record<string, UiText>> = {};
	for (const district of s.districts) {
		const off: Record<string, UiText> = {};
		for (const [id, plan] of Object.entries(plans))
			if (taken(id, district.id))
				off[id] = text(plan.unique === 'district' ? 'Only one {0} per district' : 'Only one {0} per settlement', { 0: name(id) });
		if (Object.keys(off).length) blockedSets[district.id] = off;
	}

	const cards: UiCard[] = [];
	for (const { district, slot, placed: p, building: c } of slots) {
		const where = { settlement: s.id, district: district.id, slot };
		const id = `${s.id}/${district.id}/${slot}`;
		if (!p && !c) {
			cards.push({
				id,
				group: district.id,
				title: text('Empty slot {0}', { 0: slot + 1 }),
				template: `empty:${s.kind}|${district.type}`,
				payload: { slot },
				...(blockedSets[district.id] ? { detail: { blockedSet: district.id } } : {}),
			});
			continue;
		}
		const kind = (p?.building ?? c?.building)!;
		const open: UiAction = {
			entry: { kind: 'building', id, type: kind, label: name(kind), data: { ...where, slot: String(slot) } },
			label: text('Open'),
		};
		// Other plugins' numbers for it, worded by their client plugins.
		const own = state.effects[`${district.id}/${slot}`];
		const ownNow = p ? effectLines(parts, p.building, p.level, own?.now) : [];
		const lines: UiLine[] = [];
		if (c) {
			// What it does now (its level's output and stats, and other plugins' lines), while the next level is built.
			const plan = p && plans[p.building];
			const now =
				p && plan && catalog ? effectTexts({ ...levelEffects(plan, p.level, catalog.productionMultiplier), lines: ownNow }, catalog) : [];
			if (now.length) lines.push({ text: text('Now: {0}', { 0: now }), tone: 'info' });
			lines.push({
				text: c.demolish
					? c.targetLevel
						? text('Demolishing → Lv {0}', { 0: c.targetLevel })
						: text('Demolishing → empty')
					: text('→ Lv {0}', { 0: c.targetLevel }),
				startedAt: c.startedAt,
				endsAt: c.finishesAt,
			});
			// Its own entry, as a card over the page (user 2026-11-04: "点击加速按钮，应该弹出一个卡片，供玩家选择用哪个道具
			// 进行加速"): what other plugins offer for it (e.g. items speeding it up). "Open" is the building's own screen.
			const speedUp: UiAction = {
				entry: { kind: 'construction', id: `${id}:construction`, type: kind, label: name(kind), data: { ...where, slot: String(slot) } },
				popup: true,
				label: text('Speed up'),
			};
			cards.push({
				id,
				group: district.id,
				where: ['page:city', `building#${id}`],
				icon: 'construction',
				title: p ? text('{0} · Lv {1}/{2}', { 0: name(kind), 1: p.level, 2: p.cap }) : name(kind),
				lines,
				// Open, cancel, speed up (user 2026-11-04: "打开、取消、加速").
				actions: [
					open,
					{
						command: 'buildings.cancel',
						payload: where,
						label: text('Cancel'),
						confirm: c.demolish
							? text('Stop demolishing? The level stays (nothing was spent).')
							: text('Cancel this construction? Only part of the cost is refunded.'),
					},
					speedUp,
				],
			});
			continue;
		}
		if (!p) continue;
		lines.push(...ownUpgradeLines(ownNow, effectLines(parts, p.building, p.level + 1, own?.next), p.level + 1));
		// Its card at this level comes from the static data (any level); the slot adds only what is its own: its cap
		// when raised (items), off at it, and what other plugins say it does here.
		const regular = plans[p.building]?.cap ?? 0;
		// Demolishing a level (user 2026-11-11: "前端只在点击拆除按键后，提示返还多少资源、需要多少时间"): what comes back and how
		// long it takes only in the prompt, worked out here by the rules baked in the catalog, as the server will.
		const plan = plans[p.building];
		const quote = plan && catalog?.demolish ? demolishQuote(plan, p.level, { ...catalog, demolish: catalog.demolish }) : null;
		const demolish: UiAction[] = quote
			? [
					{
						command: 'buildings.demolish',
						payload: where,
						label: text('Demolish'),
						confirm: text('Demolish one level of {0} (Lv {1} → {2})? {3} comes back; it takes {4}.', {
							0: name(kind),
							1: p.level,
							2: p.level - 1,
							3: costVar(quote.refund, resources),
							4: duration(quote.seconds),
						}),
						...(state.queue.used >= state.queue.size ? { blocked: text('Construction queue full') } : {}),
					},
				]
			: [];
		cards.push({
			id,
			group: district.id,
			template: `${p.building}@${p.level}`,
			payload: { slot },
			...(p.cap !== regular ? { title: text('{0} · Lv {1}/{2}', { 0: name(kind), 1: p.level, 2: p.cap }) } : {}),
			...(p.level >= p.cap ? { blocked: text('Level cap {0} reached', { 0: p.cap }) } : {}),
			...(lines.length ? { lines } : {}),
			...(demolish.length ? { actions: demolish } : {}),
		});
	}

	const time = speedTexts(state.time.parts);
	const head: UiLine[] = [
		{ text: keyText(kinds?.find((k) => k.id === s.kind)?.name ?? s.kind) },
		{ text: text('({0}, {1})', { 0: s.x, 1: s.y }) },
		{ text: text('build queue {0}/{1}', { 0: state.queue.used, 1: state.queue.size }), hint: breakdownTexts(state.queue.breakdown) },
		...(state.outer
			? [{ text: text('outer cities {0}/{1}', { 0: state.outer.count, 1: state.outer.cap }), hint: breakdownTexts(state.outer.breakdown) }]
			: []),
		...(s.garrison ? [{ text: text('can garrison troops') }] : []),
		...(time.length ? [{ text: text('Construction speed: {0}', { 0: time }) }] : []),
	];
	return {
		base: 'buildings.catalog',
		header: { title: s.name, lines: head.map((l) => ({ ...l, tone: 'muted' as const })) },
		// Which settlement and district the template cards' buttons are for (a single district: no groups shown).
		...(s.districts.length > 1
			? {
					// `context`: which kind of district is chosen, for what shows only there (e.g. expansion permits in outer cities).
					groups: s.districts.map((x) => ({
						id: x.id,
						label: districtLabel(x.type, x.idx),
						payload: { district: x.id },
						context: { district: x.type },
					})),
					payload: { settlement: s.id },
				}
			: { payload: { settlement: s.id, district: s.districts[0]?.id } }),
		defaultGroup: s.districts[0]?.id,
		cards,
		...(Object.keys(blockedSets).length ? { blockedSets } : {}),
		counters: { [TIME_COUNTER]: state.time.factor, [QUEUE_COUNTER]: Math.max(0, state.queue.size - state.queue.used), ...state.counters },
		placement: 'settlement',
	};
}
