// The troops plugin's words in its forms ("forms.prepare", src/shared/forms.ts): from what `prepare` sends as data (the
// units a barracks can train now, with their costs, times and limits), the choices, "at most" and the time's sources.
// What changes with play (the stock, the batch training, the units here) comes from the player's data held in the
// browser (user 2026-11-20: "前端充分利用大对象的数据"): a command anywhere shows in the forms at once.
import type { DismissFormData, FormPart, ResourcePool, TrainFormData, TroopsState } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { costVar, keyText, uiTexts } from '../../../src/shared/i18n';
import { speedTexts } from '../../../src/shared/stats';
import { timesPaid } from '../../../src/shared/troops';

// The server plugin's words (its i18n keys).
const text = uiTexts('troops');

/** The garrison of `settlement` held (undefined: not fetched yet). */
const garrisonOf = (state: TroopsState | undefined, settlement: unknown) =>
	state && typeof settlement === 'string' ? (state.garrisons.find((g) => g.settlement === settlement) ?? null) : undefined;

const train: FormPart<TrainFormData> = (d, { patch, meta, data }) => {
	const resources = meta('resources') ?? [];
	const units = meta('units') ?? [];
	const names = new Map(units.map((u) => [u.id, u.name]));
	const settlement = patch.defaults?.settlement;
	const pool = data<ResourcePool | null>('resources.pool');
	const stock = pool && pool.holder === `settlement:${settlement}` ? pool.amounts : undefined;
	const lineOf = new Map(units.map((u) => [u.id, u.trainedAt ?? '']));
	const busy = !!garrisonOf(data<TroopsState>('troops.state'), settlement)?.training.some((t) => lineOf.get(t.unit) === d.line);
	const about = text(
		busy ? 'Queued after the batch training now: paid now, refunded if cancelled before it starts.' : 'Costs and time are per unit.',
	);
	const time = speedTexts(d.time);
	return {
		...patch,
		options: {
			...patch.options,
			unit: d.units.map((u) => ({
				value: u.unit,
				label: text('{0} — {1} · {2}s each', { 0: keyText(names.get(u.unit) ?? u.unit), 1: costVar(u.cost, resources), 2: u.seconds }),
			})),
		},
		atMostBy: {
			...patch.atMostBy,
			count: {
				field: 'unit',
				values: Object.fromEntries(
					d.units.map((u) => [u.unit, stock ? Math.max(0, Math.min(u.limit, timesPaid(u.cost, stock))) : u.limit]),
				),
			},
		},
		description: time.length ? text('{0} Training speed: {1}', { 0: about, 1: time }) : about,
	};
};

// The units of the barracks' families that are here, with how many. None here: no form.
const dismiss: FormPart<DismissFormData> = (_d, { patch, data }) => {
	const g = garrisonOf(data<TroopsState>('troops.state'), patch.defaults?.settlement);
	if (g === undefined) return patch;
	const here = new Map((g?.units ?? []).filter((u) => u.count > 0).map((u) => [u.id, u.count]));
	const options = (patch.options?.unit ?? []).filter((o) => here.has(o.value)).map((o) => ({ ...o, count: here.get(o.value) }));
	if (!options.length) return false;
	return {
		...patch,
		options: { ...patch.options, unit: options },
		// The count's "at most": what is here of the unit picked (as every count box says).
		atMostBy: { ...patch.atMostBy, count: { field: 'unit', values: Object.fromEntries(here) } },
	};
};

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'troops.train', part: train, needs: ['resources.pool', 'troops.state'] }),
	defineClientPart({ point: 'forms.prepare', id: 'troops.dismiss', part: dismiss, needs: ['troops.state'] }),
];
