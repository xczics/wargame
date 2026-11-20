// What using a starter item did, in the player's data held in the browser (user 2026-11-20: "你告诉前端成功了，前端不就能
// 更新了吗？"): each function changes one view the way the item's `apply` changed it on the server (src/plugins/
// starter-items), with the numbers of its tables (static `starter-items.uses`). Pure: the tests run them. Where the
// outcome is the server's alone (a roll, a level reached), the caller makes the view old instead.
import type {
	BuildingsState,
	GarrisonInfo,
	HeroesState,
	HeroInfo,
	RealmsOverview,
	ResearchState,
	SettlementOutline,
	TroopsState,
} from '../../../src/shared/api';
import { literal } from '../../../src/shared/i18n';

/** A finish time `seconds` sooner, never before now (the server's speed-ups). */
export const sooner = (finishesAt: number, seconds: number, now: number) => Math.max(now, finishesAt - seconds * 1000);

/* ----- speed-ups ------------------------------------------------------------------------------------------------ */

/** A construction (by its slot) of the settlement sped up; `done`: it finishes now (the server then completes it). */
export function constructionSooner(
	s: BuildingsState | null,
	settlement: string,
	at: { district: string; slot: number },
	seconds: number,
	now: number,
): { state: BuildingsState | null; finishesAt?: number } {
	if (!s || s.settlement.id !== settlement) return { state: s };
	const c = s.construction.find((x) => x.district === at.district && x.slot === at.slot);
	if (!c) return { state: s };
	const finishesAt = sooner(c.finishesAt, seconds, now);
	return { state: { ...s, construction: s.construction.map((x) => (x === c ? { ...x, finishesAt } : x)) }, finishesAt };
}

/** The batch training in a barracks (`line`) of the settlement, sped up (the soonest one running there, as the server picks). */
export function garrisonSooner(
	g: GarrisonInfo | null,
	settlement: string,
	line: string,
	seconds: number,
	now: number,
): { garrison: GarrisonInfo | null; finishesAt?: number } {
	if (!g || g.settlement !== settlement) return { garrison: g };
	const b = g.training.filter((x) => x.line === line && x.finishesAt !== null).sort((a, c) => a.finishesAt! - c.finishesAt!)[0];
	if (!b) return { garrison: g };
	const finishesAt = sooner(b.finishesAt!, seconds, now);
	return { garrison: { ...g, training: g.training.map((x) => (x === b ? { ...x, finishesAt } : x)) }, finishesAt };
}

/** The same in the Army page's garrisons (a batch's barracks: where its unit is trained, `lineOf`). */
export function stateSooner(
	state: TroopsState,
	settlement: string,
	line: string,
	lineOf: (unit: string) => string | undefined,
	seconds: number,
	now: number,
): TroopsState {
	return {
		...state,
		garrisons: state.garrisons.map((g) => {
			if (g.settlement !== settlement) return g;
			const b = g.training.filter((x) => x.finishesAt !== null && lineOf(x.unit) === line).sort((a, c) => a.finishesAt! - c.finishesAt!)[0];
			return b ? { ...g, training: g.training.map((x) => (x === b ? { ...x, finishesAt: sooner(b.finishesAt!, seconds, now) } : x)) } : g;
		}),
	};
}

/** The settlement's research sped up. */
export function researchSooner(
	r: ResearchState,
	settlement: string,
	seconds: number,
	now: number,
): { state: ResearchState; finishesAt?: number } {
	const job = r.jobs.find((j) => j.settlement === settlement);
	if (!job) return { state: r };
	const finishesAt = sooner(job.finishesAt, seconds, now);
	return { state: { ...r, jobs: r.jobs.map((j) => (j === job ? { ...j, finishesAt } : j)) }, finishesAt };
}

/* ----- buildings ------------------------------------------------------------------------------------------------ */

/** A building moved to an empty slot, or two swapped, in one district (its effects go with it). */
export function buildingsMoved(s: BuildingsState | null, settlement: string, district: string, from: number, to: number, swap: boolean) {
	if (!s || s.settlement.id !== settlement) return s;
	const where = (slot: number) => (slot === from ? to : slot === to && swap ? from : slot);
	const key = (slot: number) => `${district}/${slot}`;
	const effects: BuildingsState['effects'] = {};
	for (const [k, v] of Object.entries(s.effects)) {
		const [d, slot] = k.split('/');
		effects[d === district ? key(where(Number(slot))) : k] = v;
	}
	return {
		...s,
		slots: s.slots.map((x) => (x.district === district && (x.slot === from || x.slot === to) ? { ...x, slot: where(x.slot) } : x)),
		effects,
	};
}

/** A building razed: its slot is empty (a demolition running there goes with it). */
export function buildingRazed(s: BuildingsState | null, settlement: string, district: string, slot: number) {
	if (!s || s.settlement.id !== settlement) return s;
	const here = (x: { district: string; slot: number }) => x.district === district && x.slot === slot;
	const { [`${district}/${slot}`]: _, ...effects } = s.effects;
	return { ...s, slots: s.slots.filter((x) => !here(x)), construction: s.construction.filter((x) => !here(x)), effects };
}

/* ----- heroes (as changes for the heroes' client service, which tells every view showing heroes) ------------------ */

type Listed = Omit<HeroInfo, 'bonus'>;

/** A hero's name after a name card (as the server stores what was typed: a name of its own, no given name). */
export const renamedTo = (name: string) => ({ surname: `n:${encodeURIComponent(name.trim())}`, given: '' });

/** A hero's spent free points back (the marrow pill): its attributes without them, the points free again. */
export function respecced(h: Pick<Listed, 'attrs' | 'alloc' | 'freePoints'>) {
	const attrs = { ...h.attrs };
	for (const [a, n] of Object.entries(h.alloc)) attrs[a] = (attrs[a] ?? 0) - n;
	return { attrs, alloc: {}, freePoints: h.freePoints + Object.values(h.alloc).reduce((a, n) => a + n, 0) };
}

/** Experience that keeps a hero below its next level; null: a level is reached (the server's rules say what it brings). */
export const expGained = (h: Pick<Listed, 'exp' | 'expToNext'>, exp: number) =>
	h.expToNext !== null && h.exp + exp < h.expToNext ? { exp: h.exp + exp } : null;

/** An injured hero healed at once: no longer among the injured (the realms' recovery also leaves it idle). */
export const healed = (o: RealmsOverview, hero: string): RealmsOverview => ({ ...o, injured: o.injured.filter((i) => i.hero !== hero) });

/* ----- the settlement's name ------------------------------------------------------------------------------------ */

/** A settlement renamed (by a decree), in the views that name it: as typed (trimmed, as the server keeps it). */
export const settlementRenamed = {
	outline: (o: SettlementOutline | null, id: string, name: string) => (o && o.id === id ? { ...o, name: name.trim() } : o),
	buildings: (s: BuildingsState | null, id: string, name: string) =>
		s && s.settlement.id === id ? { ...s, settlement: { ...s.settlement, name: literal(name.trim()) } } : s,
	heroes: (s: HeroesState | null, id: string, name: string) =>
		s && s.settlement.id === id ? { ...s, settlement: { ...s.settlement, name: literal(name.trim()) } } : s,
	troops: (s: TroopsState, id: string, name: string) => ({
		...s,
		garrisons: s.garrisons.map((g) => (g.settlement === id ? { ...g, name: literal(name.trim()) } : g)),
	}),
	research: (r: ResearchState, id: string, name: string) => ({
		...r,
		jobs: r.jobs.map((j) => (j.settlement === id && j.name !== undefined ? { ...j, name: name.trim() } : j)),
		here: r.here && r.here.id === id ? { ...r.here, name: name.trim() } : r.here,
	}),
};

/* ----- the rest ------------------------------------------------------------------------------------------------- */

/** Protected from bandits `hours` more, from the end of what protection there is (or from now). */
export const truce = (until: number, hours: number, now: number) => Math.max(until, now) + Math.round(hours * 3600_000);

/**
 * Runs an adventure may be repeated after travel packs changed from `before` to `after` (repeats are the rule's most,
 * or the packs, whichever is fewer): fewer packs, known; more, known only when the rule already held it (else undefined).
 */
export function repeatsAfter(repeats: number, before: number, after: number): number | undefined {
	if (after <= before) return Math.min(repeats, after);
	return repeats < before ? repeats : undefined;
}
