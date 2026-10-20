<script setup lang="ts">
// The Assistant page (docs/design/gameplay.md §15): its switches, what needs the player, the four helpers, the log and
// carrying the setup to another browser. The work itself goes on in the background while the game is open (engine.ts).
import { computed, ref } from 'vue';
import type { HeroInfo, RealmsOverview, SettlementSummary } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { formatTime } from '../../core/format';
import BuildPanel from './BuildPanel.vue';
import CampPanel from './CampPanel.vue';
import PointsPanel from './PointsPanel.vue';
import RealmPanel from './RealmPanel.vue';
import ResearchPanel from './ResearchPanel.vue';

const game = useGame('assistant');
const { store, engine } = game.use('assistant');
const data = store.data;
const cities = computed(() => (game.view('settlements.mine') ?? []) as SettlementSummary[]);
const heroes = computed(() => (game.view('heroes.list') ?? []) as HeroInfo[]);
const realms = computed(() => (game.view('realms.overview') ?? null) as RealmsOverview | null);
const TABS = ['build', 'research', 'realms', 'camps', 'points', 'log', 'setup'] as const;
const tab = ref<(typeof TABS)[number]>('build');
const area = ref('');
const shownLog = computed(() => data.log.filter((l) => !area.value || l.area === area.value));
const text = ref('');
const message = ref('');
const doImport = () => {
	try {
		store.restore(text.value);
		message.value = game.t('Restored.');
	} catch {
		message.value = game.t('That is not an assistant setup.');
	}
};
const doExport = async () => {
	text.value = store.exported();
	try {
		await navigator.clipboard.writeText(text.value);
		message.value = game.t('Copied: paste it in the other browser.');
	} catch {
		message.value = game.t('Copy the text below.');
	}
};
const scanning = ref(false);
const scan = async () => {
	scanning.value = true;
	try {
		await engine.scanNow();
	} finally {
		scanning.value = false;
	}
};
</script>

<template>
	<div class="assistant">
		<header class="card head">
			<div class="row">
				<h3>🤖 {{ game.t('Assistant') }}</h3>
				<label class="switch"><input v-model="data.on" type="checkbox" /> {{ game.t(data.on ? 'Working' : 'Paused') }}</label>
				<button type="button" class="small secondary" :disabled="scanning || !data.on" @click="scan">{{ game.t('Look now') }}</button>
			</div>
			<p class="muted">
				{{
					game.t(
						'It plays for you while this game is open in a browser (a tab in the background is fine), sending the same commands you would; it stops when the browser does. Your setup stays in this browser.',
					)
				}}
			</p>
			<div v-if="data.attention.length" class="attention">
				<span v-for="(a, i) in data.attention" :key="i">⚠️ {{ a }}</span>
				<button type="button" class="small secondary" @click="data.attention.splice(0)">{{ game.t('Seen') }}</button>
			</div>
		</header>
		<nav class="tabs">
			<button v-for="x in TABS" :key="x" type="button" :class="tab === x ? 'active' : 'secondary'" @click="tab = x">
				{{ game.t(`tab:${x}`) }}
				<template v-if="x === 'build'"> · {{ data.build.tasks.length }}</template>
				<template v-else-if="x === 'research'"> · {{ data.research.targets.length }}</template>
			</button>
		</nav>
		<section class="card">
			<template v-if="tab === 'build'">
				<label class="switch"><input v-model="data.build.on" type="checkbox" /> {{ game.t('The building queue works') }}</label>
				<BuildPanel :store="store" :cities="cities" />
			</template>
			<template v-else-if="tab === 'research'">
				<label class="switch"><input v-model="data.research.on" type="checkbox" /> {{ game.t('The research queue works') }}</label>
				<ResearchPanel :store="store" :cities="cities" />
			</template>
			<template v-else-if="tab === 'realms'">
				<label class="switch"><input v-model="data.realms.on" type="checkbox" /> {{ game.t('Adventures work') }}</label>
				<RealmPanel :store="store" :heroes="heroes" :cities="cities" :realms="realms" />
			</template>
			<template v-else-if="tab === 'camps'">
				<label class="switch"><input v-model="data.camps.on" type="checkbox" /> {{ game.t('Raids work') }}</label>
				<CampPanel :store="store" :heroes="heroes" :cities="cities" />
			</template>
			<template v-else-if="tab === 'points'">
				<label class="switch"><input v-model="data.points.on" type="checkbox" /> {{ game.t('Spending points works') }}</label>
				<PointsPanel :store="store" :heroes="heroes" :cities="cities" />
			</template>
			<template v-else-if="tab === 'log'">
				<div class="row">
					<select v-model="area">
						<option value="">{{ game.t('Everything') }}</option>
						<option v-for="a in ['build', 'research', 'realms', 'camps', 'points', 'assistant']" :key="a" :value="a">
							{{ game.t(`tab:${a}`) }}
						</option>
					</select>
					<button type="button" class="small secondary" @click="data.log.splice(0)">{{ game.t('Clear the log') }}</button>
				</div>
				<p v-if="!shownLog.length" class="muted">{{ game.t('Nothing done yet.') }}</p>
				<ul class="log">
					<li v-for="(l, i) in shownLog" :key="i" :class="{ bad: !l.ok }">
						<time>{{ formatTime(l.at) }}</time> <span>{{ l.text }}</span>
					</li>
				</ul>
			</template>
			<template v-else>
				<h4>{{ game.t('Carry it to another browser') }}</h4>
				<p class="muted">{{ game.t('The setup lives in this browser only. Copy it here, paste it there.') }}</p>
				<div class="row">
					<button type="button" class="small" @click="doExport">{{ game.t('Copy the setup') }}</button>
					<button type="button" class="small secondary" :disabled="!text" @click="doImport">{{ game.t('Use the text below') }}</button>
					<span class="muted">{{ message }}</span>
				</div>
				<textarea v-model="text" rows="6" :placeholder="game.t('Paste a copied setup here')"></textarea>
				<p class="muted">
					{{
						game.t('At most {n} commands go out after each sync (a GM rule); the rest wait for the next.', {
							n: engine.settings()?.commandsPerScan ?? 5,
						})
					}}
				</p>
			</template>
		</section>
	</div>
</template>

<style scoped>
/* The page's controls sit in lines (a switch, a short number, a choice), not in a form's column as the frame's
   styles lay labels and fields out: those are undone under this page. */
.assistant :deep(label) {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	white-space: nowrap;
	color: var(--text);
}

.assistant :deep(input),
.assistant :deep(select) {
	width: auto;
	padding: 4px 8px;
}

.assistant :deep(input[type='checkbox']),
.assistant :deep(input[type='radio']) {
	width: auto;
	margin: 0;
	padding: 0;
}

.assistant :deep(input:not([type])),
.assistant :deep(input[type='text']) {
	min-width: 14em;
}

.assistant :deep(input[type='number']) {
	width: 6.5em;
}

.assistant :deep(input[type='datetime-local']) {
	width: auto;
}

.assistant :deep(textarea) {
	width: 100%;
}

/* Buttons keep their own width in the panels' columns. */
.assistant :deep(button) {
	justify-self: start;
}

.assistant {
	display: grid;
	gap: 10px;
	max-width: 1100px;
	margin: 0 auto;
	padding: 12px;
}

.head {
	display: grid;
	gap: 6px;
}

h3,
h4 {
	margin: 0;
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 12px;
}

.switch {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-weight: 600;
}

.tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.card {
	display: grid;
	gap: 10px;
}

.attention {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 14px;
	padding: 6px 10px;
	border-radius: var(--radius);
	background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.log {
	display: grid;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
	max-height: 520px;
	overflow: auto;
	font-size: 0.9rem;
}

.log li {
	display: flex;
	gap: 10px;
	padding: 2px 0;
	border-bottom: 1px solid var(--border);
}

.log time {
	flex: none;
	color: var(--muted);
}

.log .bad span {
	color: var(--danger);
}

textarea {
	width: 100%;
	box-sizing: border-box;
	font-family: monospace;
	font-size: 0.8rem;
}

.muted {
	color: var(--muted);
}

p {
	margin: 0;
}
</style>
