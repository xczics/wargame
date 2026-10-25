<script setup lang="ts">
// Which heroes a rule acts on (docs/design/gameplay.md §15.3.0): ticked ones, or any matching the conditions; those
// left out, how many at once, how many each settlement keeps at home, and who goes first.
import { computed } from 'vue';
import type { HeroInfo, SettlementSummary } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { useGame } from '../../core/game';
import { type HeroPick, num, toggle } from './store';

const pick = defineModel<HeroPick>({ required: true });
const props = defineProps<{ heroes: HeroInfo[]; cities: SettlementSummary[]; states?: boolean }>();
const game = useGame('assistant');
const attributes = computed(() => game.meta.heroes?.attributes ?? []);
const name = (h: HeroInfo) => game.t(nameKey(h));
const STATES = ['idle', 'duty', 'adventure', 'injured'] as const;
</script>

<template>
	<div class="picker">
		<details open>
			<summary>{{ game.t('Heroes named') }} ({{ pick.ids.length }})</summary>
			<div class="chips">
				<label v-for="h in props.heroes" :key="h.id" class="chip">
					<input type="checkbox" :checked="pick.ids.includes(h.id)" @change="toggle(pick.ids, h.id)" />
					{{ name(h) }} · {{ game.t('Lv {n}', { n: h.level }) }}
				</label>
				<span v-if="!props.heroes.length" class="muted">{{ game.t('No heroes yet.') }}</span>
			</div>
		</details>
		<label class="row"><input v-model="pick.byConditions" type="checkbox" /> {{ game.t('Also any hero matching:') }}</label>
		<div v-if="pick.byConditions" class="conditions">
			<label>
				{{ game.t('Level') }}
				<input type="number" min="1" :value="pick.levelMin ?? ''" @input="pick.levelMin = num(($event.target as HTMLInputElement).value)" />
				–
				<input type="number" min="1" :value="pick.levelMax ?? ''" @input="pick.levelMax = num(($event.target as HTMLInputElement).value)" />
			</label>
			<label>
				{{ game.t('Talent') }}
				<input
					type="number"
					min="0"
					:value="pick.talentMin ?? ''"
					@input="pick.talentMin = num(($event.target as HTMLInputElement).value)"
				/>
				–
				<input
					type="number"
					min="0"
					:value="pick.talentMax ?? ''"
					@input="pick.talentMax = num(($event.target as HTMLInputElement).value)"
				/>
			</label>
			<label>
				{{ game.t('Gender') }}
				<select v-model="pick.gender">
					<option value="">{{ game.t('Any') }}</option>
					<option value="m">{{ game.t('Male') }}</option>
					<option value="f">{{ game.t('Female') }}</option>
				</select>
			</label>
			<div v-for="(c, i) in pick.attrs" :key="i" class="row">
				<select v-model="c.attr">
					<option v-for="a in attributes" :key="a.id" :value="a.id">{{ game.t(a.name) }}</option>
				</select>
				<select v-model="c.op">
					<option value=">=">≥</option>
					<option value="<=">≤</option>
				</select>
				<input v-model.number="c.value" type="number" min="0" />
				<button type="button" class="small secondary" @click="pick.attrs.splice(i, 1)">✕</button>
			</div>
			<button type="button" class="small secondary" @click="pick.attrs.push({ attr: attributes[0]?.id ?? '', op: '>=', value: 100 })">
				{{ game.t('+ an attribute condition (equipment included)') }}
			</button>
			<div v-if="props.states !== false" class="chips">
				<span class="muted">{{ game.t('State') }}</span>
				<label v-for="st in STATES" :key="st" class="chip">
					<input type="checkbox" :checked="pick.states.includes(st)" @change="toggle(pick.states, st)" /> {{ game.t(`state:${st}`) }}
				</label>
			</div>
			<div class="chips">
				<span class="muted">{{ game.t('Home') }}</span>
				<label v-for="c in props.cities" :key="c.id" class="chip">
					<input type="checkbox" :checked="pick.homes.includes(c.id)" @change="toggle(pick.homes, c.id)" /> {{ game.t(c.name) }}
				</label>
			</div>
		</div>
		<details>
			<summary>{{ game.t('Left out') }} ({{ pick.exclude.length }})</summary>
			<div class="chips">
				<label v-for="h in props.heroes" :key="h.id" class="chip">
					<input type="checkbox" :checked="pick.exclude.includes(h.id)" @change="toggle(pick.exclude, h.id)" /> {{ name(h) }}
				</label>
			</div>
		</details>
		<div class="row wrap">
			<label>
				{{ game.t('At most at once') }}
				<input
					type="number"
					min="1"
					:value="pick.max ?? ''"
					:placeholder="game.t('no limit')"
					@input="pick.max = num(($event.target as HTMLInputElement).value)"
				/>
			</label>
			<label>
				{{ game.t('Each settlement keeps') }}
				<input
					type="number"
					min="0"
					:value="pick.keepPerCity ?? ''"
					placeholder="0"
					@input="pick.keepPerCity = num(($event.target as HTMLInputElement).value)"
				/>
			</label>
			<label>
				{{ game.t('First') }}
				<select v-model="pick.order">
					<option value="levelAsc">{{ game.t('Lowest level') }}</option>
					<option value="levelDesc">{{ game.t('Highest level') }}</option>
					<option value="nearUp">{{ game.t('Nearest a level-up') }}</option>
					<option value="attr">{{ game.t('Highest attribute') }}</option>
					<option value="random">{{ game.t('Random') }}</option>
				</select>
			</label>
			<select v-if="pick.order === 'attr'" v-model="pick.orderAttr">
				<option v-for="a in attributes" :key="a.id" :value="a.id">{{ game.t(a.name) }}</option>
			</select>
		</div>
	</div>
</template>

<style scoped>
.picker {
	display: grid;
	gap: 6px;
}

.chips,
.row,
.conditions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
}

.conditions {
	padding: 6px 8px;
	border-left: 2px solid var(--border);
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	white-space: nowrap;
}

input[type='number'] {
	width: 5.5em;
}

summary {
	cursor: pointer;
}

.muted {
	color: var(--muted);
}
</style>
