// The Realms page, assembled in the browser (AGENTS.md: the server sends data only) from the player's realms, heroes,
// adventures and injuries (`realms.overview` with the static `realms.tasks`: `realmsInfo`), over the static `realms.catalog`. Pure: the tests run it.
// - `realms.list` (generic `ui.rows`): pick an idle hero (client param `hero`), see each open realm's tasks with how
//   far that hero would get (`margin`, the same code the server fights with), and send it;
// - `realms.away` / `realms.injured` (generic `ui.timers`): heroes away, then the injured with their treatment.
import type { RealmsCatalog, RealmsInfo } from '../../../src/shared/api';
import { amount, amounts, duration } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { margin } from '../../../src/shared/realms';
import type { RowsData, TimersData, UiRow, UiTimer } from '../../../src/shared/ui';

// The realms plugin's own words (its i18n keys): the page reads as it did when the server built it.
const text = uiTexts('realms');

export function realmsList(o: RealmsInfo | undefined, params: Readonly<Record<string, string>>): RowsData | undefined {
	if (!o) return undefined;
	const idle = o.heroes.filter((h) => h.idle);
	const hero = idle.find((h) => h.id === params.hero) ?? idle[0];
	const stats = hero ? o.heroStats[hero.id] : undefined;
	const repeatMax = o.repeats;
	// A button per realm; the newest open one by default (the shop on the left follows the choice).
	const latest = [...o.realms].reverse().find((r) => r.unlocked) ?? o.realms[0];
	return {
		base: 'realms.catalog',
		tabs: o.realms.map((r) => ({
			id: r.id,
			label: text(r.unlocked ? '{0}. {1}' : '{0}. {1} 🔒', { 0: r.order, 1: keyText(r.name) }),
		})),
		...(latest ? { defaultTab: latest.id } : {}),
		...(hero
			? {
					picker: {
						param: 'hero',
						options: idle.map((h) => ({ value: h.id, label: text('{0} (Lv {1})', { 0: h.name, 1: h.level }) })),
						selected: hero.id,
					},
				}
			: {}),
		sections: [
			{
				rows: [],
				lines: stats
					? [
							{
								text: text(
									stats.luck
										? 'Attack {a} · Defence {d} · HP {h} · Recovery {r}% · Luck +{l}%'
										: 'Attack {a} · Defence {d} · HP {h} · Recovery {r}%',
									{
										a: amount(stats.attack),
										d: amount(stats.defense),
										h: amount(stats.hp),
										r: amount(stats.recovery, 1),
										l: amount(stats.luck ?? 0, 1),
									},
								),
								tone: 'muted',
							},
						]
					: [{ text: text('No idle hero.'), tone: 'muted' }],
			},
			...o.realms.map((r): RowsData['sections'][number] => ({
				group: r.id,
				// Locked: its own title and how to open it; open: the catalog's, and the tasks with what is the player's.
				...(r.unlocked
					? {}
					: {
							title: text('{0}. {1} · 🔒 {2}', { 0: r.order, 1: keyText(r.name), 2: text('Locked') }),
							intro: [
								...(r.quote ? [{ text: keyText(r.quote), tone: 'muted' as const }] : []),
								{ text: text('Open it with its key, dropped by the hardest task of the realm before.'), tone: 'muted' as const },
							],
						}),
				rows: r.unlocked
					? r.tasks.map((t): UiRow => {
							const k = stats ? margin(stats, t.groups, o.minDamage) : null;
							return {
								id: `${r.id}/${t.index}`,
								title: text('{0}. {1}', { 0: t.index + 1, 1: keyText(t.name) }),
								hide: [t.cleared ? 'undiscovered' : 'drops'],
								lines:
									k !== null
										? [
												{
													// Four rough outlooks, not the exact group: strikes may miss.
													text:
														k >= o.outlook.easy
															? text('Outlook: an easy win')
															: k >= o.outlook.even
																? text('Outlook: worth a try')
																: k >= o.outlook.hard
																	? text('Outlook: an uphill fight')
																	: text('Outlook: a heavy loss'),
													tone: k >= o.outlook.even ? ('info' as const) : ('warn' as const),
												},
											]
										: [],
								actions: [
									{
										command: 'realms.adventure',
										payload: { hero: hero?.id, realm: r.id, task: t.index },
										label: text('Set out'),
										...(hero ? {} : { blocked: text('No idle hero.') }),
									},
									...(repeatMax > 0
										? [
												{
													command: 'realms.adventure',
													payload: { hero: hero?.id, realm: r.id, task: t.index, repeat: repeatMax },
													label: text('Set out {0} times', { 0: repeatMax + 1 }),
													...(hero ? {} : { blocked: text('No idle hero.') }),
												},
											]
										: []),
								],
							};
						})
					: [],
			})),
		],
	};
}

/** A hero's name as name-part keys (the client spells them); its id if it is not the player's any more. */
const heroName = (o: RealmsInfo, id: string) => o.heroes.find((h) => h.id === id)?.name ?? id;

export function realmsAway(o: RealmsInfo | undefined): TimersData | undefined {
	if (!o) return undefined;
	const realm = (id: string) => o.realms.find((r) => r.id === id);
	return {
		title: text('On adventures'),
		items: o.adventures.map((a): UiTimer => ({
			id: a.id,
			title: text('{hero}', { hero: heroName(o, a.hero) }),
			lines: [
				{
					text: text('{realm} · {task}', {
						realm: keyText(realm(a.realm)?.name ?? a.realm),
						task: keyText(realm(a.realm)?.tasks[a.task]?.name ?? ''),
					}),
					tone: 'muted',
				},
				...(a.repeat ? [{ text: text('Then {0} more runs (a loss stops them)', { 0: a.repeat }), tone: 'muted' as const }] : []),
			],
			startedAt: a.startedAt,
			endsAt: a.finishesAt,
		})),
		...(o.adventures.length ? {} : { notes: [{ text: text('Nobody is away.'), tone: 'muted' as const }] }),
	};
}

export function realmsInjured(o: RealmsInfo | undefined, catalog: RealmsCatalog | undefined): TimersData | null | undefined {
	if (!o) return undefined;
	if (!o.injured.length) return null;
	// The costs are written with the resources' icons, from the static catalog.
	if (!catalog) return undefined;
	return {
		title: text('Injured heroes'),
		items: o.injured.map((i): UiTimer => ({
			id: i.hero,
			title: text('{hero}', { hero: heroName(o, i.hero) }),
			...(i.healingUntil
				? { endsAt: i.healingUntil, lines: [{ text: text('Being treated'), tone: 'muted' as const }] }
				: {
						actions: [
							{
								command: 'realms.heal',
								payload: { hero: i.hero },
								label: text('Treat ({cost}, {t})', { cost: amounts(i.cost, catalog.icons), t: duration(i.seconds) }),
							},
						],
					}),
		})),
	};
}
