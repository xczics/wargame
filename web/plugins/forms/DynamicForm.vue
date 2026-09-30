<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { ResolvedForm } from '../../../src/shared/api';
import { useGame } from '../../core/game';

const props = defineProps<{
	form: ResolvedForm;
	/** Override how the form is sent (e.g. the GM console runs it for another player). */
	submit?: (command: string, payload: Record<string, unknown>) => Promise<boolean>;
}>();
const game = useGame();
const values = reactive<Record<string, string | number | boolean>>({});
const busy = ref(false);

function reset() {
	for (const f of props.form.fields)
		values[f.name] = f.default ?? (f.type === 'checkbox' ? false : f.type === 'select' ? (f.options?.[0]?.value ?? '') : '');
}
watch(() => props.form, reset, { immediate: true });

async function submit() {
	if (props.form.confirm && !confirm(game.t(props.form.confirm))) return;
	const payload: Record<string, unknown> = {};
	for (const f of props.form.fields) {
		const v = values[f.name];
		if (v === '' && !f.required) continue;
		payload[f.name] = f.type === 'number' ? Number(v) : v;
	}
	busy.value = true;
	const ok = props.submit ? await props.submit(props.form.command, payload) : await game.command(props.form.command, payload);
	if (ok) game.toast('Done', 'info');
	busy.value = false;
}
</script>

<template>
	<form class="card dynamic-form" @submit.prevent="submit">
		<h2>{{ game.t(form.title) }}</h2>
		<small v-if="form.description">{{ game.t(form.description) }}</small>
		<template v-for="f in form.fields" :key="f.name">
			<label v-if="f.type === 'checkbox'" class="check"><input v-model="values[f.name]" type="checkbox" /> {{ game.t(f.label) }}</label>
			<label v-else-if="f.type === 'select'">
				{{ game.t(f.label) }}
				<select v-model="values[f.name]" :required="f.required">
					<option v-for="o in f.options" :key="o.value" :value="o.value">{{ game.t(o.label) }}</option>
				</select>
			</label>
			<label v-else-if="f.type !== 'hidden'">
				{{ game.t(f.label) }}
				<input
					v-model="values[f.name]"
					:type="f.type"
					:required="f.required"
					:min="f.min"
					:max="f.max"
					:maxlength="f.maxLength"
					:placeholder="f.placeholder && game.t(f.placeholder)"
				/>
			</label>
		</template>
		<button type="submit" :disabled="busy">{{ game.t(form.submitLabel ?? 'Submit') }}</button>
	</form>
</template>

<style scoped>
.dynamic-form {
	display: grid;
	gap: 10px;
}

.dynamic-form h2 {
	margin: 0;
}

.check {
	display: flex;
	gap: 8px;
	align-items: center;
}

.check input {
	width: auto;
}

button {
	justify-self: start;
}
</style>
