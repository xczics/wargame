// Battle on the client: the attack formation editor, used by the march form (widget
// "battle.formation"). The battle reports themselves are rendered by war-reports.
import { defineClientPlugin } from '../../core/game';
import FormationWidget, { type FormationValue } from './FormationWidget.vue';

export default defineClientPlugin({
	id: 'battle',
	dependsOn: ['forms'],
	setup(game) {
		game.messages('zh-CN', {
			Formation: '阵列',
			'Lane {n}': '第{n}路',
			'Lv {n}': '{n}级',
			'at most {n}': '最多 {n}',
			'No such troops here: this lane stays empty.': '出发城池没有这类部队：这一路空着（相克仍然生效）。',
			'Support units': '辅助兵种',
			'march along outside the lanes': '随军出征，不进阵列',
			'{n} in the lanes, {m} support units': '阵列 {n} 人，辅助 {m} 人',
		});
		game.use('forms').widget('battle.formation', {
			component: FormationWidget,
			// The lanes, and every unit sent: the lanes' plus the support units.
			payload(value) {
				const v = value as FormationValue;
				const units: Record<string, number> = { ...v.aux };
				for (const l of v.lanes) for (const [u, n] of Object.entries(l.units)) units[u] = (units[u] ?? 0) + n;
				return { formation: v.lanes, units };
			},
		});
	},
});
