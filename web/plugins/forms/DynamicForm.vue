<script setup lang="ts">
import { computed, reactive, ref, watch, watchEffect } from 'vue';
import type { FormBudget, FormField, ResolvedForm } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import { widgets } from './widgets';

const props = defineProps<{
	form: ResolvedForm;
	/** Override how the form is sent (e.g. the GM console runs it for another player). */
	submit?: (command: string, payload: Record<string, unknown>) => Promise<boolean>;
}>();
const game = useGame();
const values = reactive<Record<string, string | number | boolean>>({});
/** Values of 'widget' fields: whatever their editor keeps (objects, lists...). */
const widgetValues = reactive<Record<string, unknown>>({});
const busy = ref(false);
/**
 * Fields the player has changed since the last submit. The form is re-sent whenever the game
 * state refreshes (every minute, after any command); those fields keep what was typed, the
 * others follow the new defaults.
 */
const touched = new Set<string>();
const touch = (name: string) => touched.add(name);

function reset() {
	for (const f of props.form.fields) {
		if (touched.has(f.name)) continue;
		if (f.type === 'widget') widgetValues[f.name] = undefined;
		else values[f.name] = f.default ?? (f.type === 'checkbox' ? false : f.type === 'select' ? (f.options?.[0]?.value ?? '') : '');
	}
}
watch(() => props.form, reset, { immediate: true });

/** Options offered now: their `when` conditions hold, and no other select of the same `distinct` group has them. */
function offered(f: FormField) {
	const taken = new Set(
		f.distinct
			? props.form.fields.filter((o) => o !== f && o.distinct === f.distinct && values[o.name] !== '').map((o) => String(values[o.name]))
			: [],
	);
	return (f.options ?? []).filter(
		(o) => !taken.has(o.value) && Object.entries(o.when ?? {}).every(([k, v]) => String(values[k] ?? '') === v),
	);
}
// A choice that is no longer offered (e.g. the origin changed) falls back to the first offered one.
watchEffect(() => {
	for (const f of props.form.fields) {
		if (f.type !== 'select' || !f.options?.length) continue;
		const now = offered(f);
		if (!now.some((o) => o.value === values[f.name])) values[f.name] = now[0]?.value ?? '';
	}
});

const num = (name: string) => Number(values[name]) || 0;
const budgets = computed(() =>
	(props.form.budgets ?? []).map((b: FormBudget) => {
		const used = b.use.reduce((sum, name) => sum + num(name), 0);
		const total = Object.entries(b.capacity).reduce((sum, [name, weight]) => sum + num(name) * weight, 0);
		return { ...b, used, total, over: used > total, after: b.use[b.use.length - 1] };
	}),
);
const blocked = computed(() => budgets.value.some((b) => b.over));

async function submit() {
	if (blocked.value) return;
	if (props.form.confirm && !confirm(game.t(props.form.confirm))) return;
	const payload: Record<string, unknown> = {};
	for (const f of props.form.fields) {
		if (f.type === 'widget') {
			const widget = widgets.get(f.widget ?? '');
			const v = widgetValues[f.name];
			if (v !== undefined) Object.assign(payload, widget?.payload ? widget.payload(v) : { [f.name]: v });
			continue;
		}
		const v = values[f.name];
		if (v === '' && !f.required) continue;
		payload[f.name] = f.type === 'number' ? Number(v) : v;
	}
	busy.value = true;
	const ok = props.submit ? await props.submit(props.form.command, payload) : await game.command(props.form.command, payload);
	if (ok) {
		game.toast('Done', 'info');
		touched.clear();
		reset();
	}
	busy.value = false;
}
</script>

<template>
	<form class="card dynamic-form" @submit.prevent="submit">
		<h2>{{ game.t(form.title) }}</h2>
		<small v-if="form.description">{{ game.t(form.description) }}</small>
		<template v-for="f in form.fields" :key="f.name">
			<label v-if="f.type === 'checkbox'" class="check"
				><input v-model="values[f.name]" type="checkbox" @change="touch(f.name)" /> {{ game.t(f.label) }}</label
			>
			<label v-else-if="f.type === 'select'">
				{{ game.t(f.label) }}
				<select v-model="values[f.name]" :required="f.required" @change="touch(f.name)">
					<option v-for="o in offered(f)" :key="o.value" :value="o.value">{{ game.t(o.label) }}</option>
				</select>
			</label>
			<component
				:is="widgets.get(f.widget ?? '')!.component"
				v-else-if="f.type === 'widget' && widgets.has(f.widget ?? '')"
				v-model="widgetValues[f.name]"
				:field="f"
				@update:model-value="touch(f.name)"
				:values="values"
			/>
			<label v-else-if="f.type !== 'hidden' && f.type !== 'widget'">
				{{ game.t(f.label) }}
				<input
					v-model="values[f.name]"
					:type="f.type"
					@input="touch(f.name)"
					:required="f.required"
					:min="f.min"
					:max="f.max"
					:maxlength="f.maxLength"
					:placeholder="f.placeholder && game.t(f.placeholder)"
				/>
			</label>
			<small v-for="b in budgets.filter((x) => x.after === f.name)" :key="b.label" class="budget" :class="{ over: b.over }">
				{{ game.t('{label}: {used} / {total}', { label: game.t(b.label), used: formatNumber(b.used), total: formatNumber(b.total) }) }}
				<template v-if="b.over"> · {{ game.t('over the limit') }}</template>
			</small>
		</template>
		<button type="submit" :disabled="busy || blocked">{{ game.t(form.submitLabel ?? 'Submit') }}</button>
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

.budget {
	font-weight: 600;
}

.budget.over {
	color: var(--danger);
}

button {
	justify-self: start;
}
</style>
