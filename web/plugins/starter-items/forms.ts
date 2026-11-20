// The starter items' words in their forms ("forms.prepare", src/shared/forms.ts): from what `prepare` sends as data
// (odds, buildings, outer cities, heroes, limits...), the choices and descriptions. Names from the meta.
import type { FormOption, FormPart, HeroInfo, Meta, StarterItemsFormData, TroopsState } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { nameKey } from '../../../src/shared/heroes';
import { duration } from '../../../src/shared/format';
import { costVar, keyText, uiTexts } from '../../../src/shared/i18n';
import { oddsText } from '../../../src/shared/items';
import type { UiText } from '../../../src/shared/ui';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-items');

type Data = StarterItemsFormData;
/** `head`, then the odds if there are any. */
const withOdds = (head: UiText, odds: UiText | null) => (odds ? text('{0} · {1}', { 0: head, 1: odds }) : head);

const parts: { [K in keyof Data]: FormPart<Data[K]> } = {
	'starter-items.odds': (o, { patch }) => {
		const odds = oddsText(o);
		const description = patch.description ? withOdds(patch.description, odds) : odds;
		return { ...patch, ...(description ? { description } : {}) };
	},
	'starter-items.stat': ({ stat, n }, { patch }) => ({ ...patch, description: text('{0}: {1}', { 0: text(`effect:${stat}`), 1: n }) }),
	'starter-items.limit': ({ kind, limit, max }, { patch, meta }) => ({
		...patch,
		description: text('Limit ({0}): {1}', {
			0: keyText(meta('settlementKinds')?.find((k) => k.id === kind)?.name ?? kind),
			1: max === null ? `${limit}` : `${limit}/${max}`,
		}),
	}),
	'starter-items.caps': (caps, { patch, meta }) => {
		const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
		const target = caps.map((c) => ({
			value: c.value,
			label: withOdds(
				text('{0} · Lv {1}/{2}', { 0: keyText(names.get(c.building) ?? c.building), 1: c.level, 2: c.cap }),
				oddsText(c.odds),
			),
		}));
		return { ...patch, options: { ...patch.options, target } };
	},
	'starter-items.razable': (list, { patch, meta }) => {
		const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
		const target = list.map((c) => ({
			value: c.value,
			label: text('{0} · Lv {1}', { 0: keyText(names.get(c.building) ?? c.building), 1: c.level }),
		}));
		return { ...patch, options: { ...patch.options, target } };
	},
	'starter-items.grants': (grants, { patch }) => {
		const district = grants.map((g) => ({
			value: g.value,
			label: withOdds(text('Outer city {0} · {1} slots', { 0: g.idx, 1: g.slots }), oddsText(g.odds)),
		}));
		return { ...patch, options: { ...patch.options, district } };
	},
	// Name-part keys: spelled for the language shown.
	'starter-items.heroes': (list, { patch }) => ({
		...patch,
		options: { ...patch.options, hero: list.map((h) => ({ value: h.id, label: text('{0} (Lv {1})', { 0: h.name, 1: h.level }) })) },
	}),
	// From the heroes held here (`heroes.list`, its `needs`); none such: the form is hidden. Without them yet: shown, no choice.
	'starter-items.pick': (pick, { patch, data }) => {
		const list = data<Omit<HeroInfo, 'bonus'>[]>('heroes.list');
		if (!list) return patch;
		const ok = list.filter((h) =>
			pick === 'exp' ? h.expToNext !== null : pick === 'respec' ? Object.values(h.alloc).some((n) => n > 0) : true,
		);
		if (!ok.length) return false;
		const hero = ok.map((h) => ({ value: h.id, label: text('{0} (Lv {1})', { 0: nameKey(h), 1: h.level }) }));
		return { ...patch, options: { ...patch.options, hero } };
	},
	// The settlement's barracks with a batch training, from the garrisons held here (`troops.state`); none: hidden.
	'starter-items.barracks': ({ settlement, here }, { patch, meta, data }) => {
		const state = data<TroopsState>('troops.state');
		const g = state?.garrisons.find((x) => x.settlement === settlement);
		if (!state) return patch;
		const lineOf = new Map((meta<Meta['units']>('units') ?? []).map((u) => [u.id, u.trainedAt]));
		const busy = [
			...new Set((g?.training ?? []).flatMap((b) => (b.finishesAt !== null && lineOf.get(b.unit) ? [lineOf.get(b.unit)!] : []))),
		];
		if (!busy.length) return false;
		const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
		return {
			...patch,
			defaults: { ...patch.defaults, barracks: here && busy.includes(here) ? here : busy[0] },
			options: { ...patch.options, barracks: busy.map((b) => ({ value: b, label: keyText(names.get(b) ?? b) })) },
		};
	},
	'starter-items.renaming': (name, { patch }) => ({ ...patch, description: text('Renaming {0}', { 0: name }) }),
	// The district first, then the slots of that district (`when`); a swap lists only occupied slots as the target.
	'starter-items.move': ({ swap, districts }, { patch, meta }) => {
		const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
		const district: FormOption[] = [];
		const from: FormOption[] = [];
		const to: FormOption[] = [];
		for (const d of districts) {
			const when = { district: d.id };
			district.push({ value: d.id, label: d.inner ? text('Inner city') : text('Outer city {0}', { 0: d.idx }) });
			const taken = new Set(d.placed.map((p) => p.slot));
			for (const p of d.placed) {
				const label = text('Slot {0} · {1} Lv {2}', { 0: p.slot + 1, 1: keyText(names.get(p.building) ?? p.building), 2: p.level });
				from.push({ value: String(p.slot), label, when });
				if (swap) to.push({ value: String(p.slot), label, when });
			}
			if (!swap)
				for (let slot = 0; slot < d.slots; slot++)
					if (!taken.has(slot)) to.push({ value: String(slot), label: text('Empty slot {0}', { 0: slot + 1 }), when });
		}
		return { ...patch, options: { ...patch.options, district, from, to } };
	},
	'starter-items.boost': (until, { patch }) => ({
		...patch,
		description: text('Boosted until {0} UTC', { 0: new Date(until).toISOString().slice(0, 16).replace('T', ' ') }),
	}),
	'starter-items.constructions': (list, { patch, meta }) => {
		const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
		const target = list.map((c) => ({
			value: c.value,
			label: text('{0} → Lv {1}', { 0: keyText(names.get(c.building) ?? c.building), 1: c.level }),
		}));
		return { ...patch, options: { ...patch.options, target } };
	},
	'starter-items.stipend': ({ amounts, rank }, { patch, meta }) => ({
		...patch,
		description: text('As {0}: {1}', { 0: keyText(rank), 1: costVar(amounts, meta('resources') ?? []) }),
	}),
	'starter-items.truce': (seconds, { patch }) => ({
		...patch,
		description: text('Safe from bandits for {0} more', { 0: duration(seconds) }),
	}),
};

/** What the parts that pick from the player's data read (fetched with the forms, and followed at once). */
const NEEDS: Partial<Record<keyof Data, string[]>> = { 'starter-items.pick': ['heroes.list'], 'starter-items.barracks': ['troops.state'] };

export const formParts = Object.entries(parts).map(([id, part]) =>
	defineClientPart({ point: 'forms.prepare', id, part, ...(NEEDS[id as keyof Data] ? { needs: NEEDS[id as keyof Data] } : {}) }),
);
