// The Army page's timers, assembled in the browser (AGENTS.md: the server sends data only): incoming attacks
// (`armies.alerts`, from `armies.incoming`, standing out) and the player's marches (`armies.marches`, from
// `armies.list`), with the meta's unit and mission names and resource icons. Pure: the tests run them.
import type { ArmyMarch, IncomingAttack, ResourceMeta, UnitMeta } from '../../../src/shared/api';
import { amount, amounts } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { TimersData, UiText, UiTimer } from '../../../src/shared/ui';

// The armies plugin's own words (its i18n keys): the timers read as they did when the server built them.
const text = uiTexts('armies');

const unitList = (units: Record<string, number>, names: UnitMeta[] | undefined): UiText[] =>
	Object.entries(units)
		.filter(([, n]) => n > 0)
		.map(([id, n]) => text('{unit} ×{n}', { unit: keyText(names?.find((u) => u.id === id)?.name ?? id), n: amount(n) }));

export function alertTimers(list: IncomingAttack[] | undefined, units: UnitMeta[] | undefined): TimersData | undefined {
	if (list === undefined) return undefined;
	return {
		title: text('⚠️ Incoming attacks'),
		tone: 'warn',
		items: list.map((a): UiTimer => ({
			id: a.id,
			title: text('{name} attacks {target}', { name: a.attackerName ?? text('Someone'), target: a.place }),
			endsAt: a.arrivesAt,
			...(a.intel
				? {
						lines: [
							{
								text: a.intel.units
									? text(a.intel.level >= 3 ? 'Scouts report: {units}' : 'Scouts estimate: {units}', {
											units: unitList(a.intel.units, units),
										})
									: text('Scouts estimate: about {n} troops', { n: amount(a.intel.total ?? 0) }),
								tone: 'muted' as const,
							},
						],
					}
				: {}),
		})),
	};
}

export function marchTimers(
	list: ArmyMarch[] | undefined,
	units: UnitMeta[] | undefined,
	resources: ResourceMeta[] | undefined,
	missions: Record<string, string> | undefined,
): TimersData | undefined {
	if (list === undefined) return undefined;
	const ic = Object.fromEntries((resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
	return {
		title: text('Marches'),
		items: list.map((a): UiTimer => {
			const out = a.phase === 'outbound';
			const carried = out ? a.provisions : a.loot;
			return {
				id: a.id,
				title: text('{from} → ({x}, {y})', { from: a.fromName, x: a.target.x, y: a.target.y }),
				startedAt: out ? a.departedAt : a.arrivesAt,
				endsAt: out ? a.arrivesAt : a.returnsAt,
				lines: [
					{
						text: text('{mission} · {phase}', { mission: keyText(missions?.[a.mission] ?? `armies.${a.mission}`), phase: text(a.phase) }),
						tone: 'muted',
					},
					{ text: text('{units}', { units: unitList(a.units, units) }) },
					...(Object.keys(carried).length
						? [
								{
									text: text(out ? 'Provisions: {list}' : 'Bringing back: {list}', { list: amounts(carried, ic, 1) }),
									tone: 'muted' as const,
								},
							]
						: []),
					...(out && Object.keys(a.cargo).length
						? [{ text: text('Supplies: {list}', { list: amounts(a.cargo, ic, 1) }), tone: 'muted' as const }]
						: []),
					...(a.report
						? [
								{
									text: text('{outcome} · {target}', { outcome: text(`outcome:${a.report.outcome}`), target: a.reportTarget! }),
									...(a.report.outcome === 'defeat' ? { tone: 'warn' as const } : {}),
								},
							]
						: []),
				],
				actions: [
					...(out && !a.staged
						? [
								{
									command: 'armies.recall',
									payload: { id: a.id },
									label: text('Recall'),
									confirm: text('Turn this army back? The unused provisions and everything it carries come back with it.'),
								},
							]
						: []),
					...(a.report ? [{ page: 'mail', label: text('Full report in the mailbox') }] : []),
				],
			};
		}),
		...(list.length
			? {}
			: { notes: [{ text: text('No armies away from home. Pick a tile on the map to send troops.'), tone: 'muted' as const }] }),
	};
}
