// The armies plugin's words in its forms ("forms.prepare", src/shared/forms.ts): in those sending troops, the supplies'
// boxes, "<resource> (supplies)" and, for a transport, "<resource> (to fetch)" (their labels come as the resources'
// names); the GM's speed-up, from the data `prepare` sends. Which settlements have troops to send, how many and each
// box's "at most" come from the garrisons held in the browser (`troops.state`; user 2026-11-20: "前端充分利用大对象的
// 数据"): a march, training or battle anywhere shows in these forms at once.
import type {
	ArmiesHastenFormData,
	FormField,
	FormPart,
	GatherFormData,
	SendFormData,
	SettlementSummary,
	TroopsState,
} from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';
import { heldGarrisons } from '../../../src/shared/troops';
import type { LanesInputData } from '../../../src/shared/ui';

// The server plugin's words (its i18n keys).
const text = uiTexts('armies');

const supplies: FormPart<Record<string, never>> = (_d, { patch }) => ({
	...patch,
	fields: patch.fields?.map((f) =>
		f.name.startsWith('cargo.')
			? { ...f, label: text('{0} (supplies)', { 0: f.label }) }
			: f.name.startsWith('pickup.')
				? { ...f, label: text('{0} (to fetch)', { 0: f.label }) }
				: f,
	),
});

// The GM's: marches on their way, with the minutes left of the current leg.
const hasten: FormPart<ArmiesHastenFormData> = (marches, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		id: marches.map((m) => ({
			value: m.id,
			label: text(m.outbound ? '({0}, {1}) · Outbound · {2} min' : '({0}, {1}) · Returning · {2} min', { 0: m.x, 1: m.y, 2: m.minutes }),
		})),
	},
});

/** Each garrison held, by settlement: its units with their counts (none: not fetched yet). */
const garrisons = (state: TroopsState | undefined) => (state ? heldGarrisons(state) : undefined);

// The origins with troops ("Capital (1,200)"), the unit boxes of types there are, each "at most" for the origin picked,
// a lanes editor's pools, and when the march would arrive (widget "armies.arrival", worked out here: ./travel.ts). No
// troops anywhere: no form.
const send: FormPart<SendFormData> = (_d, { command, patch, data }) => {
	const held = garrisons(data<TroopsState>('troops.state'));
	if (!held) return patch;
	const total = (id: string) => Object.values(held.get(id) ?? {}).reduce((a, b) => a + b, 0);
	const from = (patch.options?.from ?? []).filter((o) => total(o.value) > 0).map((o) => ({ ...o, count: total(o.value) }));
	if (!from.length) return false;
	const pools = Object.fromEntries(from.map((o) => [o.value, held.get(o.value)!]));
	const present = new Set(Object.values(pools).flatMap((g) => Object.keys(g)));
	const field = (f: FormField): FormField | null => {
		if (f.name.startsWith('units.')) {
			const unit = f.name.slice('units.'.length);
			if (!present.has(unit)) return null;
			return { ...f, atMostBy: { field: 'from', values: Object.fromEntries(from.map((o) => [o.value, pools[o.value][unit] ?? 0])) } };
		}
		// A lanes editor choosing the units from the origin's garrison (e.g. the attack formation).
		const lanes = f.type === 'widget' ? (f.data as Partial<LanesInputData> | undefined) : undefined;
		if (lanes?.poolField === 'from' && lanes.pools && lanes.options)
			return { ...f, data: { ...lanes, pools, options: lanes.options.filter((o) => present.has(o.id)) } };
		return f;
	};
	const chosen = patch.defaults?.from;
	return {
		...patch,
		options: { ...patch.options, from },
		defaults: { ...patch.defaults, from: from.some((o) => o.value === chosen) ? chosen! : from[0].value },
		fields: [...(patch.fields?.flatMap((f) => field(f) ?? []) ?? []), arrival(command)],
	};
};
/** The expected arrival; to one's own settlements faster (the commands that go there). */
const arrival = (command: string): FormField => ({
	name: 'arrival',
	label: text('Arrival'),
	type: 'widget',
	widget: 'armies.arrival',
	data: { own: command === 'armies.transfer' || command === 'armies.transport' },
});

// Gathering: the boxes of the carrying units here, each with how many ("Infantry (1,200)", at most that); none here, or no
// other settlement to fetch from: no form.
const gather: FormPart<GatherFormData> = (_d, { patch, data }) => {
	const mine = data<SettlementSummary[]>('settlements.mine');
	if (mine && !mine.some((s) => s.id !== patch.defaults?.settlement)) return false;
	const held = garrisons(data<TroopsState>('troops.state'));
	if (!held) return patch;
	const here = held.get(String(patch.defaults?.settlement)) ?? {};
	const fields = (patch.fields ?? []).flatMap((f) => {
		const n = f.name.startsWith('units.') ? (here[f.name.slice('units.'.length)] ?? 0) : undefined;
		return n === undefined ? [f] : n > 0 ? [{ ...f, count: n, max: n }] : [];
	});
	if (!fields.some((f) => f.name.startsWith('units.'))) return false;
	return { ...patch, fields };
};

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'armies.send', part: send, needs: ['troops.state', 'armies.speeds', 'settlements.mine'] }),
	defineClientPart({ point: 'forms.prepare', id: 'armies.gather', part: gather, needs: ['troops.state', 'settlements.mine'] }),
	defineClientPart({ point: 'forms.prepare', id: 'armies.supplies', part: supplies }),
	defineClientPart({ point: 'forms.prepare', id: 'armies.hasten', part: hasten }),
];
