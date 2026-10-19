<script setup lang="ts">
// The GM's puzzle screen (its own tab of the GM console; docs/design/gameplay.md §13.2): the puzzles, and one edited at
// a time — the picture (cropped to a square and scaled here: the Worker never touches images), the grid, where pieces
// drop (a tree of places; quick ways to spread them), what completing it brings and what a duplicate piece turns into.
import { computed, onActivated, onMounted, ref, shallowRef } from 'vue';
import type { PuzzleDefData, Reward, PuzzlesGmData } from '../../../src/shared/api';
import { randomId } from '../../../src/shared/random';
import { ApiError, errorText } from '../../core/api';
import { useGame } from '../../core/game';
import SiteTree from './SiteTree.vue';

const game = useGame('puzzles');
// The generic reward editor (client plugin "widgets").
const RewardEditor = game.widgetOf('ui.reward-editor');
const data = shallowRef<PuzzlesGmData | null>(null);
const editing = ref<(PuzzleDefData & { saved: boolean }) | null>(null);
const busy = ref(false);

async function load() {
	try {
		data.value = await game.request<PuzzlesGmData>('/api/gm/puzzles');
	} catch (err) {
		game.toast(errorText(err));
	}
}
onMounted(load);
onActivated(load);

const blank = (): PuzzleDefData & { saved: boolean } => ({
	id: randomId(),
	name: '',
	grid: 4,
	status: 'draft',
	image: null,
	limit: 1,
	duplicate: null,
	drops: [],
	rewards: [],
	saved: false,
});
const edit = (p: PuzzleDefData) => open({ ...structuredClone(p), saved: true });
/** Another puzzle in the editor: a picture picked for the last one is not carried over. */
function open(p: PuzzleDefData & { saved: boolean }) {
	editing.value = p;
	source.value = null;
	unsent.value = false;
}
/** The grid is fixed once the stored puzzle left the draft (players' pieces are numbered by it). */
const gridFixed = computed(() => {
	const e = editing.value;
	const was = e && data.value?.puzzles.find((p) => p.id === e.id);
	return !!was && was.status !== 'draft';
});

/* ----- pieces: "A1 B3" <-> numbers ------------------------------------------------------------ */
const pieceName = (grid: number, i: number) => `${String.fromCharCode(65 + Math.floor(i / grid))}${(i % grid) + 1}`;
const piecesText = (grid: number, pieces: number[]) =>
	pieces.length === grid * grid ? game.t('all') : pieces.map((i) => pieceName(grid, i)).join(' ');
function parsePieces(grid: number, raw: string): number[] {
	if (raw.trim() === game.t('all') || raw.trim() === 'all') return Array.from({ length: grid * grid }, (_, i) => i);
	const out = new Set<number>();
	for (const w of raw
		.toUpperCase()
		.split(/[\s,，]+/)
		.filter(Boolean)) {
		const m = /^([A-Z])(\d+)$/.exec(w);
		if (!m) continue;
		const row = m[1].charCodeAt(0) - 65;
		const col = Number(m[2]) - 1;
		if (row < grid && col >= 0 && col < grid) out.add(row * grid + col);
	}
	return [...out].sort((a, b) => a - b);
}

/* ----- the picture ------------------------------------------------------------------------------ */
const source = shallowRef<HTMLImageElement | null>(null);
const crop = ref({ size: 100, x: 50, y: 50 });
const preview = ref<HTMLCanvasElement | null>(null);
/** A picture picked but not uploaded yet: saving uploads it first (it was easy to save without it). */
const unsent = ref(false);
function pick(e: Event) {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) return;
	const img = new Image();
	img.onload = () => {
		source.value = img;
		unsent.value = true;
		crop.value = { size: 100, x: 50, y: 50 };
		draw();
	};
	img.src = URL.createObjectURL(file);
}
/** The square cut of the picture (size: % of its short side; x / y: where its centre is, %), scaled to at most 1536. */
function draw(): HTMLCanvasElement | null {
	const img = source.value;
	const canvas = preview.value;
	if (!img || !canvas) return null;
	const short = Math.min(img.naturalWidth, img.naturalHeight);
	const side = Math.max(16, Math.round((short * crop.value.size) / 100));
	const sx = Math.round((img.naturalWidth - side) * (crop.value.x / 100));
	const sy = Math.round((img.naturalHeight - side) * (crop.value.y / 100));
	const out = Math.min(1536, side);
	canvas.width = out;
	canvas.height = out;
	canvas.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, out, out);
	return canvas;
}
async function upload(): Promise<boolean> {
	const canvas = draw();
	if (!canvas || !editing.value) return false;
	busy.value = true;
	try {
		const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/webp', 0.9));
		if (!blob) throw new Error('no picture');
		const res = await fetch('/api/gm/puzzles/image', { method: 'POST', body: blob, credentials: 'same-origin' });
		const body = (await res.json()) as { key?: string; error?: { code: string; message: string } };
		if (!res.ok || !body.key) throw new ApiError(body.error?.code ?? 'http_error', body.error?.message ?? res.statusText, res.status);
		editing.value.image = body.key;
		unsent.value = false;
		game.toast('Picture uploaded', 'info');
		return true;
	} catch (err) {
		game.toast(errorText(err));
		return false;
	} finally {
		busy.value = false;
	}
}

/* ----- where pieces drop -------------------------------------------------------------------------- */
const toggle = (list: string[], a: string) => {
	const i = list.indexOf(a);
	if (i >= 0) list.splice(i, 1);
	else list.push(a);
};
const quick = ref({ sites: [] as string[], common: 1, rare: 0, rareChance: 0.1, value: 0.5 });
/** Every piece on the chosen places at one chance (k rare ones at another, picked at random). */
function spread() {
	const e = editing.value;
	if (!e || !quick.value.sites.length) return game.toast('Choose where first');
	const all = Array.from({ length: e.grid * e.grid }, (_, i) => i);
	const rare = new Set<number>();
	while (rare.size < Math.min(quick.value.rare, all.length)) rare.add(all[Math.floor(Math.random() * all.length)]);
	const sites = [...quick.value.sites];
	const rule = (pieces: number[], chance: number) => ({ pieces, sites: [...sites], chance: chance / 100, value: quick.value.value });
	e.drops = [
		rule(
			all.filter((i) => !rare.has(i)),
			quick.value.common,
		),
		...(rare.size
			? [
					rule(
						[...rare].sort((a, b) => a - b),
						quick.value.rareChance,
					),
				]
			: []),
	].filter((r) => r.pieces.length);
}
/** A place's address ("npc-camps/npc-fortress/3") as its names ("NPC camps / NPC fortress / Level 3"). */
function placeName(address: string): string {
	const names: string[] = [];
	let level = data.value?.sites ?? [];
	for (const id of address.split('/')) {
		const node = level.find((s) => s.id === id);
		if (!node) return address;
		names.push(game.t(node.label));
		level = node.children ?? [];
	}
	return names.join(' / ');
}
/** Rolls there to have every piece of a rule, on average (each piece its own chance: n pieces, H(n) / p). */
const rollsFor = (n: number, p: number) => {
	if (p <= 0) return Infinity;
	let h = 0;
	for (let i = 1; i <= n; i++) h += 1 / i;
	return Math.round(h / p);
};

/* ----- saving --------------------------------------------------------------------------------------- */
async function save() {
	const e = editing.value;
	if (!e) return;
	if (unsent.value && !(await upload())) return;
	busy.value = true;
	try {
		const { saved: _, ...def } = e;
		await game.request('/api/gm/puzzles', { method: 'POST', body: def });
		game.toast('Saved', 'info');
		await load();
		const fresh = data.value?.puzzles.find((p) => p.id === def.id);
		if (fresh) edit(fresh);
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
	}
}
const statuses = ['draft', 'live', 'closed', 'hidden'] as const;
const newReward = (): Reward => ({ kind: 'resources', config: {} });
</script>

<template>
	<div class="gm-puzzles">
		<p v-if="!data" class="muted">{{ game.t('Loading…') }}</p>
		<template v-else>
			<div class="list">
				<button type="button" @click="open(blank())">{{ game.t('New puzzle') }}</button>
				<table>
					<tbody>
						<tr v-for="p in data.puzzles" :key="p.id" :class="{ active: editing?.id === p.id }" @click="edit(p)">
							<td>{{ p.name }}</td>
							<td>{{ p.grid }} × {{ p.grid }}</td>
							<td>{{ game.t(`status:${p.status}`) }}</td>
						</tr>
					</tbody>
				</table>
			</div>

			<form v-if="editing" class="editor" @submit.prevent="save">
				<div class="row">
					<label>{{ game.t('Name') }} <input v-model="editing.name" required maxlength="40" /></label>
					<label>
						{{ game.t('Status') }}
						<select v-model="editing.status">
							<option v-for="s in statuses" :key="s" :value="s">{{ game.t(`status:${s}`) }}</option>
						</select>
					</label>
					<label>
						{{ game.t('Pieces a side') }}
						<input v-model.number="editing.grid" type="number" min="2" :max="data.maxGrid" :disabled="gridFixed" />
					</label>
					<label>{{ game.t('Claims per player') }} <input v-model.number="editing.limit" type="number" min="1" /></label>
				</div>
				<p v-if="gridFixed" class="muted">{{ game.t('The grid is fixed once the puzzle is out of the draft.') }}</p>

				<fieldset>
					<legend>{{ game.t('Picture') }}</legend>
					<p v-if="editing.image" class="muted">{{ editing.image }}</p>
					<input type="file" accept="image/*" @change="pick" />
					<div v-show="source" class="crop">
						<canvas ref="preview" class="preview"></canvas>
						<label>{{ game.t('Size') }} <input v-model.number="crop.size" type="range" min="30" max="100" @input="draw" /></label>
						<label>{{ game.t('Left / right') }} <input v-model.number="crop.x" type="range" min="0" max="100" @input="draw" /></label>
						<label>{{ game.t('Up / down') }} <input v-model.number="crop.y" type="range" min="0" max="100" @input="draw" /></label>
						<button type="button" :disabled="busy" @click="upload">{{ game.t('Upload this square') }}</button>
					</div>
				</fieldset>

				<fieldset>
					<legend>{{ game.t('Where pieces drop') }}</legend>
					<div class="quick">
						<SiteTree :sites="data.sites" :selected="quick.sites" @toggle="(a) => toggle(quick.sites, a)" />
						<div class="row">
							<label>{{ game.t('Chance (%)') }} <input v-model.number="quick.common" type="number" min="0" max="100" step="0.01" /></label>
							<label>{{ game.t('Rare pieces') }} <input v-model.number="quick.rare" type="number" min="0" /></label>
							<label
								>{{ game.t('Rare chance (%)') }} <input v-model.number="quick.rareChance" type="number" min="0" max="100" step="0.01"
							/></label>
							<label>{{ game.t('Value') }} <input v-model.number="quick.value" type="number" min="0" step="0.1" /></label>
							<button type="button" @click="spread">{{ game.t('Spread all pieces') }}</button>
						</div>
					</div>
					<div v-for="(r, i) in editing.drops" :key="i" class="rule">
						<div class="row">
							<label>
								{{ game.t('Pieces') }}
								<input
									:value="piecesText(editing.grid, r.pieces)"
									@change="r.pieces = parsePieces(editing.grid, ($event.target as HTMLInputElement).value)"
								/>
							</label>
							<label>
								{{ game.t('Chance (%)') }}
								<input
									:value="Math.round(r.chance * 10000) / 100"
									type="number"
									min="0"
									max="100"
									step="0.01"
									@input="r.chance = Number(($event.target as HTMLInputElement).value) / 100"
								/>
							</label>
							<label>{{ game.t('Value') }} <input v-model.number="r.value" type="number" min="0" step="0.1" /></label>
							<button type="button" class="link" @click="editing.drops.splice(i, 1)">{{ game.t('Remove') }}</button>
						</div>
						<p class="muted">
							{{ game.t('At: {places}', { places: r.sites.map(placeName).join('、') }) }} ·
							{{
								game.t('All {n} of these in about {rolls} rolls there', { n: r.pieces.length, rolls: rollsFor(r.pieces.length, r.chance) })
							}}
						</p>
						<details>
							<summary>{{ game.t('Places') }}</summary>
							<SiteTree :sites="data.sites" :selected="r.sites" @toggle="(a) => toggle(r.sites, a)" />
						</details>
					</div>
					<button type="button" @click="editing.drops.push({ pieces: [], sites: [], chance: 0.01, value: 0.5 })">
						{{ game.t('Add a rule') }}
					</button>
				</fieldset>

				<fieldset>
					<legend>{{ game.t('Rewards') }}</legend>
					<component
						:is="RewardEditor"
						v-for="(r, i) in editing.rewards"
						:key="i"
						:kinds="data.kinds"
						:reward="r"
						@change="(x: Reward) => (editing!.rewards[i] = x)"
						@remove="editing.rewards.splice(i, 1)"
					/>
					<button type="button" @click="editing.rewards.push(newReward())">{{ game.t('Add a reward') }}</button>
				</fieldset>

				<fieldset>
					<legend>{{ game.t('Exchanging a piece (Items page) brings') }}</legend>
					<component
						:is="RewardEditor"
						v-if="editing.duplicate"
						:kinds="data.kinds"
						:reward="editing.duplicate"
						@change="(x: Reward) => (editing!.duplicate = x)"
						@remove="editing.duplicate = null"
					/>
					<button v-else type="button" @click="editing.duplicate = newReward()">{{ game.t('Add') }}</button>
				</fieldset>

				<button type="submit" :disabled="busy">{{ game.t('Save') }}</button>
			</form>
		</template>
	</div>
</template>

<style scoped>
.gm-puzzles {
	display: grid;
	gap: 16px;
}

.list table {
	width: 100%;
	border-collapse: collapse;
}

.list tr {
	cursor: pointer;
}

.list tr.active {
	color: var(--accent);
}

.editor {
	display: grid;
	gap: 12px;
}

.row {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	align-items: end;
}

.row label {
	display: grid;
	gap: 2px;
}

fieldset {
	display: grid;
	gap: 8px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.crop {
	display: grid;
	gap: 6px;
	max-width: 320px;
}

.preview {
	width: 100%;
	aspect-ratio: 1;
	border-radius: var(--radius);
}

.rule {
	display: grid;
	gap: 4px;
	padding: 8px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.muted {
	color: var(--muted);
	margin: 0;
}
</style>
