<script setup lang="ts">
import { reactive } from 'vue';
import type { Invite } from '../../../src/shared/api';
import { formatTime } from '../../core/format';
import { useGame } from '../../core/game';
import { copyText, useResource } from './useResource';

const game = useGame();
const { data: invites, error, reload } = useResource<Invite[]>(() => '/api/invites');
const form = reactive({ maxUses: 1, expiresInHours: null as number | null, note: '' });

const usable = (i: Invite) => !i.revoked && i.uses < i.maxUses && !(i.expiresAt && i.expiresAt < Date.now());

async function create() {
	try {
		const invite = await game.request<Invite>('/api/invites', {
			method: 'POST',
			body: { maxUses: form.maxUses, expiresInHours: form.expiresInHours || undefined, note: form.note || undefined },
		});
		await copyText(invite.link, game.toast);
		form.note = '';
		await reload();
	} catch (err) {
		game.toast(err instanceof Error ? err.message : String(err));
	}
}

async function revoke(i: Invite) {
	if (!confirm(`Revoke ${i.code}?`)) return;
	await game.request(`/api/invites/${i.code}`, { method: 'DELETE' });
	await reload();
}
</script>

<template>
	<form class="row" @submit.prevent="create">
		<label>Max uses <input v-model.number="form.maxUses" type="number" min="1" /></label>
		<label>Expires (hours) <input v-model.number="form.expiresInHours" type="number" min="1" placeholder="never" /></label>
		<label class="grow">Note <input v-model="form.note" maxlength="200" /></label>
		<button type="submit">Create invite</button>
	</form>
	<p v-if="error" class="error">{{ error }}</p>
	<p v-else-if="invites?.length === 0" class="muted">No invites yet.</p>
	<table v-else-if="invites">
		<thead>
			<tr>
				<th>Code</th>
				<th>Uses</th>
				<th>Expires</th>
				<th>Note</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="i in invites" :key="i.code" :class="{ dead: !usable(i) }">
				<td>
					<code>{{ i.code }}</code>
				</td>
				<td>{{ i.uses }}/{{ i.maxUses }}</td>
				<td>{{ i.revoked ? 'revoked' : formatTime(i.expiresAt) }}</td>
				<td>{{ i.note }}</td>
				<td class="actions">
					<template v-if="usable(i)">
						<button type="button" class="small" @click="copyText(i.link, game.toast)">Copy link</button>
						<button type="button" class="small danger" @click="revoke(i)">Revoke</button>
					</template>
				</td>
			</tr>
		</tbody>
	</table>
</template>

<style scoped>
form {
	margin-bottom: 12px;
}

label {
	min-width: 110px;
}

.grow {
	flex: 1;
	min-width: 160px;
}

.dead {
	opacity: 0.45;
}

.actions {
	white-space: nowrap;
	text-align: right;
}

.actions button + button {
	margin-left: 4px;
}
</style>
