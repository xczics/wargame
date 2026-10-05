<script setup lang="ts">
import { ruleText } from './names';
import { errorText } from '../../core/api';
import { computed, ref, shallowRef, watch } from 'vue';
import type { ConfigEntry } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import ValueEditor from './ValueEditor.vue';

const props = defineProps<{ rule: ConfigEntry }>();
const emit = defineEmits<{ changed: [] }>();
const game = useGame('gm-panel');

// Edit the effective value (content default merged with any override).
const draft = shallowRef<unknown>(structuredClone(props.rule.value));
watch(
	() => props.rule,
	() => (draft.value = structuredClone(props.rule.value)),
);
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.rule.value));
const busy = ref(false);
const path = computed(() => `/api/gm/config/${encodeURIComponent(props.rule.key)}`);

async function save() {
	busy.value = true;
	try {
		await game.request(path.value, { method: 'PUT', body: { value: draft.value } });
		game.toast(game.t('Saved'), 'info');
		emit('changed');
		await game.refresh();
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
	}
}

const undo = () => (draft.value = structuredClone(props.rule.value));

async function reset() {
	await game.request(path.value, { method: 'DELETE' });
	emit('changed');
	await game.refresh();
}
</script>

<template>
	<div class="rule">
		<div class="head">
			<strong>{{ ruleText(game, rule) }}</strong>
			<span v-if="rule.overridden" class="badge">{{ game.t('changed') }}</span>
		</div>
		<small class="muted"
			><code>{{ rule.key }}</code></small
		>
		<p v-if="rule.error" class="error">{{ game.t('Stored override ignored') }}: {{ game.t(rule.error) }}</p>
		<ValueEditor :value="draft" :rule="{ key: rule.key, owner: rule.owner }" @update="draft = $event" />
		<div class="row">
			<button type="button" class="small" :disabled="!dirty || busy" @click="save">{{ game.t('Save') }}</button>
			<button v-if="dirty" type="button" class="small secondary" @click="undo">{{ game.t('Undo') }}</button>
			<button v-if="rule.overridden" type="button" class="small secondary" @click="reset">{{ game.t('Reset to default') }}</button>
		</div>
	</div>
</template>

<style scoped>
.rule {
	display: grid;
	gap: 8px;
	padding: 12px 0;
	border-bottom: 1px solid var(--border);
}

.head {
	display: flex;
	gap: 6px;
	align-items: baseline;
}
</style>
