<script setup lang="ts">
// Widget "ui.reward-editor" (GM screens: a puzzle's rewards, a mail's attachments): one reward, its kind, then the fields
// that kind declares (the server's `rewards` register, GET /api/gm/rewards). "pool": several rewards, one drawn by weight.
import { computed } from 'vue';
import type { Reward, RewardKindInfo } from '../../src/shared/api';
import { useGame } from '../core/game';

defineOptions({ name: 'RewardEditor' });
const props = defineProps<{ kinds: RewardKindInfo[]; reward: Reward; inPool?: boolean }>();
const emit = defineEmits<{ change: [reward: Reward]; remove: [] }>();
const game = useGame('widgets');
const kind = computed(() => props.kinds.find((k) => k.id === props.reward.kind));
const config = computed(() => (props.reward.config ?? {}) as Record<string, unknown>);
type Option = { weight: number; kind: string; config: unknown };
const options = computed(() => ((config.value.options as Option[] | undefined) ?? []) as Option[]);

const setKind = (id: string) => emit('change', { kind: id, config: id === 'pool' ? { options: [] } : {} });
const setField = (name: string, value: unknown) => emit('change', { kind: props.reward.kind, config: { ...config.value, [name]: value } });
const setOptions = (list: Option[]) => emit('change', { kind: 'pool', config: { options: list } });
const number = (v: string) => (v === '' ? undefined : Number(v));
</script>

<template>
	<div class="reward">
		<div class="row">
			<select :value="reward.kind" @change="setKind(($event.target as HTMLSelectElement).value)">
				<option v-for="k in kinds.filter((x) => !inPool || x.id !== 'pool')" :key="k.id" :value="k.id">{{ game.t(k.name) }}</option>
			</select>
			<button type="button" class="link" @click="emit('remove')">{{ game.t('Remove') }}</button>
		</div>
		<div v-if="reward.kind !== 'pool'" class="fields">
			<label v-for="f in kind?.fields ?? []" :key="f.name">
				{{ game.t(f.label) }}
				<select
					v-if="f.type === 'select'"
					:value="config[f.name] ?? ''"
					@change="setField(f.name, ($event.target as HTMLSelectElement).value)"
				>
					<option value="">—</option>
					<option v-for="o in f.options ?? []" :key="o.value" :value="o.value">{{ game.t(o.label) }}</option>
				</select>
				<input
					v-else-if="f.type === 'number'"
					type="number"
					:min="f.min"
					:max="f.max"
					:value="config[f.name] ?? ''"
					@input="setField(f.name, number(($event.target as HTMLInputElement).value))"
				/>
				<input v-else :value="config[f.name] ?? ''" @input="setField(f.name, ($event.target as HTMLInputElement).value)" />
			</label>
		</div>
		<div v-else class="pool">
			<div v-for="(o, i) in options" :key="i" class="option">
				<label>
					{{ game.t('Weight') }}
					<input
						type="number"
						min="0"
						:value="o.weight"
						@input="setOptions(options.map((x, j) => (j === i ? { ...x, weight: Number(($event.target as HTMLInputElement).value) } : x)))"
					/>
				</label>
				<RewardEditor
					:kinds="kinds"
					:reward="{ kind: o.kind, config: o.config }"
					in-pool
					@change="(r) => setOptions(options.map((x, j) => (j === i ? { ...x, kind: r.kind, config: r.config } : x)))"
					@remove="setOptions(options.filter((_, j) => j !== i))"
				/>
			</div>
			<button type="button" @click="setOptions([...options, { weight: 1, kind: 'resources', config: {} }])">
				{{ game.t('Add an option') }}
			</button>
		</div>
	</div>
</template>

<style scoped>
.reward {
	display: grid;
	gap: 6px;
	padding: 8px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.row,
.fields {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: end;
}

.fields label {
	display: grid;
	gap: 2px;
}

.fields input {
	width: 7em;
}

.option {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 8px;
	align-items: start;
}
</style>
