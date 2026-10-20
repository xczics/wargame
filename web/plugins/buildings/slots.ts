// The City page's slot cards (`buildings.slots`), assembled in the browser (AGENTS.md: the server sends data only) from
// the settlement's buildings (`buildings.state`) and the static catalog (`buildings.catalog`). Pure: the tests run it.
// One card per slot of the district chosen on the district board: which template it is (building and level), what is
// being built, what is unique and already there, the counters, and other plugins' lines for it (a wall's strength).
import type { BuildingsState } from '../../../src/shared/api';
import {
	type BuildingCatalog,
	effectTexts,
	levelEffects,
	ownUpgradeLines,
	QUEUE_COUNTER,
	TIME_COUNTER,
} from '../../../src/shared/buildings';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { CardsData, UiAction, UiCard, UiLine, UiText } from '../../../src/shared/ui';

// The buildings plugin's own words (its i18n keys): the cards read as they did when the server built them.
const text = uiTexts('buildings');

export function slotCards(state: BuildingsState | null | undefined, catalog: BuildingCatalog | undefined): CardsData | undefined {
	if (state === undefined) return undefined;
	if (state === null) return { cards: [], empty: text('You have no settlement yet'), placement: 'settlement' };
	const s = state.settlement;
	const plans = catalog?.buildings ?? {};
	const name = (id: string) => keyText(plans[id]?.name ?? id);
	const districtLabel = (type: string, idx: number): UiText =>
		type === 'inner' ? text('Inner city') : type === 'outer' ? text('Outer city {0}', { 0: idx }) : text('Fortress');
	const placed = new Map(state.slots.map((p) => [`${p.district}/${p.slot}`, p]));
	const building = new Map(state.construction.map((c) => [`${c.district}/${c.slot}`, c]));

	// What is unique and already there (or being built), by district: off in its empty slots' lists.
	const has = (b: string, district?: string) =>
		state.slots.some((p) => p.building === b && (!district || p.district === district)) ||
		state.construction.some((c) => c.building === b && (!district || c.district === district));
	const blockedSets: Record<string, Record<string, UiText>> = {};
	for (const district of s.districts) {
		const off: Record<string, UiText> = {};
		for (const [id, plan] of Object.entries(plans))
			if (plan.unique === 'district' ? has(id, district.id) : plan.unique && has(id))
				off[id] = text(plan.unique === 'district' ? 'Only one {0} per district' : 'Only one {0} per settlement', { 0: name(id) });
		if (Object.keys(off).length) blockedSets[district.id] = off;
	}

	const cards: UiCard[] = [];
	for (const district of s.districts)
		for (let slot = 0; slot < district.slots; slot++) {
			const where = { settlement: s.id, district: district.id, slot };
			const id = `${s.id}/${district.id}/${slot}`;
			const p = placed.get(`${district.id}/${slot}`) ?? null;
			const c = building.get(`${district.id}/${slot}`) ?? null;
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
			const own = state.effects[`${district.id}/${slot}`];
			const lines: UiLine[] = [];
			if (c) {
				// What it does now (its level's output and stats, and other plugins' lines), while the next level is built.
				const plan = p && plans[p.building];
				const now =
					p && plan && catalog
						? effectTexts({ ...levelEffects(plan, p.level, catalog.productionMultiplier), lines: own?.now ?? [] }, catalog)
						: [];
				if (now.length) lines.push({ text: text('Now: {0}', { 0: now }), tone: 'info' });
				lines.push({ text: text('→ Lv {0}', { 0: c.targetLevel }), startedAt: c.startedAt, endsAt: c.finishesAt });
				cards.push({
					id,
					group: district.id,
					where: ['page:city', `building#${id}`],
					icon: '🏗️',
					title: p ? text('{0} · Lv {1}/{2}', { 0: name(kind), 1: p.level, 2: p.cap }) : name(kind),
					lines,
					actions: [
						{
							command: 'buildings.cancel',
							payload: where,
							label: text('Cancel'),
							confirm: text('Cancel this construction? Only part of the cost is refunded.'),
						},
						open,
					],
				});
				continue;
			}
			if (!p) continue;
			lines.push(...ownUpgradeLines(own?.now ?? [], own?.next ?? [], p.level + 1));
			// Its card at this level comes from the static data (any level); the slot adds only what is its own: its cap
			// when raised (items), off at it, and what other plugins say it does here.
			const regular = plans[p.building]?.cap ?? 0;
			cards.push({
				id,
				group: district.id,
				template: `${p.building}@${p.level}`,
				payload: { slot },
				...(p.cap !== regular ? { title: text('{0} · Lv {1}/{2}', { 0: name(kind), 1: p.level, 2: p.cap }) } : {}),
				...(p.level >= p.cap ? { blocked: text('Level cap {0} reached', { 0: p.cap }) } : {}),
				...(lines.length ? { lines } : {}),
			});
		}

	const head: UiLine[] = [
		{ text: keyText(s.kindName) },
		{ text: text('({0}, {1})', { 0: s.x, 1: s.y }) },
		{ text: text('build queue {0}/{1}', { 0: state.queue.used, 1: state.queue.size }), hint: state.queue.sources },
		...(state.outer
			? [{ text: text('outer cities {0}/{1}', { 0: state.outer.count, 1: state.outer.cap }), hint: state.outer.sources }]
			: []),
		...(s.garrison ? [{ text: text('can garrison troops') }] : []),
		...(state.time.parts.length ? [{ text: text('Construction time: {0}', { 0: state.time.parts }) }] : []),
	];
	return {
		base: 'buildings.catalog',
		header: { title: s.name, lines: head.map((l) => ({ ...l, tone: 'muted' as const })) },
		// Which settlement and district the template cards' buttons are for (a single district: no groups shown).
		...(s.districts.length > 1
			? {
					groups: s.districts.map((x) => ({ id: x.id, label: districtLabel(x.type, x.idx), payload: { district: x.id } })),
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
