<script setup lang="ts">
// The GM's personalization tab: every field other plugins registered (the site's icon and title here), a picture picked
// from the built-in ones or the uploaded ones (or uploaded now), a text typed. Values are rules: set and reset through the
// rules' routes (audited there), so the static view "personalization.site" brings them to everyone.
import { onActivated, onMounted, reactive, shallowRef } from 'vue';
import type { PersonalizationGmData } from '../../../src/shared/api';
import type { UiText } from '../../../src/shared/ui';
import { ApiError, errorText } from '../../core/api';
import { useGame } from '../../core/game';

defineProps<{ label?: UiText }>();
const game = useGame('personalization');
const data = shallowRef<PersonalizationGmData | null>(null);
const drafts = reactive<Record<string, string>>({});
const busy = shallowRef(false);

async function load() {
	try {
		data.value = await game.request<PersonalizationGmData>('/api/gm/personalization');
		for (const f of data.value.fields) if (f.kind === 'text') drafts[f.key] = f.value;
	} catch (err) {
		game.toast(errorText(err));
	}
}
onMounted(load);
onActivated(load);

async function run(change: () => Promise<unknown>) {
	busy.value = true;
	try {
		await change();
		game.toast('Saved', 'info');
		await load();
		await game.refresh();
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
	}
}
const set = (key: string, value: string) =>
	run(() => game.request(`/api/gm/config/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }));
const reset = (key: string) => run(() => game.request(`/api/gm/config/${encodeURIComponent(key)}`, { method: 'DELETE' }));

async function upload(key: string, e: Event) {
	const input = e.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	busy.value = true;
	try {
		// As it is: the server checks the bytes (the Worker has no CPU for images, and an icon is small anyway).
		const res = await fetch('/api/gm/personalization/image', { method: 'POST', body: file, credentials: 'same-origin' });
		const body = (await res.json()) as { key?: string; error?: { code: string; message: string; text?: UiText } };
		if (!res.ok || !body.key)
			throw new ApiError(body.error?.code ?? 'http_error', body.error?.message ?? res.statusText, res.status, body.error?.text);
		game.toast('Picture uploaded', 'info');
		busy.value = false;
		await set(key, body.key);
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
		input.value = '';
	}
}
</script>

<template>
	<div class="personalization">
		<p v-if="!data" class="muted">{{ game.t('Loading…') }}</p>
		<template v-else>
			<p class="muted">{{ game.t('Players see changes with their next sync (within a minute).') }}</p>
			<section v-for="f in data.fields" :key="f.key" class="field">
				<h3>{{ game.t(f.label) }}</h3>
				<template v-if="f.kind === 'image'">
					<h4>{{ game.t('Built in') }}</h4>
					<div class="choices">
						<button
							v-for="c in f.choices"
							:key="c.id"
							type="button"
							class="choice"
							:class="{ active: f.value === c.id }"
							:disabled="busy"
							:title="game.t(c.name)"
							@click="set(f.key, c.id)"
						>
							<img :src="c.url" alt="" width="48" height="48" />
							<span>{{ game.t(c.name) }}</span>
						</button>
					</div>
					<template v-if="data.uploads.length">
						<h4>{{ game.t('Uploaded') }}</h4>
						<div class="choices">
							<button
								v-for="u in data.uploads"
								:key="u"
								type="button"
								class="choice"
								:class="{ active: f.value === u }"
								:disabled="busy"
								:title="u"
								@click="set(f.key, u)"
							>
								<img :src="game.fileUrl(u)" alt="" width="48" height="48" />
								<span>{{ f.value === u ? game.t('In use') : game.t('Use') }}</span>
							</button>
						</div>
					</template>
					<label v-if="data.canUpload" class="upload">
						{{ game.t('Upload a picture') }}
						<input
							type="file"
							accept="image/png,image/svg+xml,image/webp,image/x-icon,.ico"
							:disabled="busy"
							@change="(e) => upload(f.key, e)"
						/>
						<small class="muted">{{
							game.t('PNG, SVG, WebP or ICO, at most {kb} KB; square pictures look best. SVG: drawings only (no scripts or links).', {
								kb: data.maxImage / 1024,
							})
						}}</small>
					</label>
					<p v-else class="muted">{{ game.t('No file bucket here: only the built-in icons.') }}</p>
				</template>
				<form v-else class="text" @submit.prevent="set(f.key, drafts[f.key] ?? '')">
					<input v-model="drafts[f.key]" :maxlength="f.max" :placeholder="game.t(`Empty: the game's own title`)" />
					<button type="submit" :disabled="busy">{{ game.t('Save') }}</button>
				</form>
				<button v-if="f.overridden" type="button" class="secondary" :disabled="busy" @click="reset(f.key)">
					{{ game.t('Back to the default') }}
				</button>
			</section>
		</template>
	</div>
</template>

<style scoped>
.personalization {
	display: grid;
	gap: 20px;
	max-width: 760px;
}

.field {
	display: grid;
	gap: 8px;
	justify-items: start;
}

.field h3,
.field h4 {
	margin: 0;
}

.choices {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.choice {
	display: grid;
	justify-items: center;
	gap: 4px;
	padding: 8px;
	min-width: 76px;
	background: var(--surface);
	color: var(--text);
	border: 2px solid var(--border);
	border-radius: var(--radius);
}

.choice.active {
	border-color: var(--accent);
}

.choice img {
	width: 48px;
	height: 48px;
	object-fit: contain;
}

.upload {
	display: grid;
	gap: 4px;
}

.text {
	display: flex;
	gap: 8px;
	width: min(100%, 480px);
}

.text input {
	flex: 1;
}

.text button {
	white-space: nowrap;
}
</style>
