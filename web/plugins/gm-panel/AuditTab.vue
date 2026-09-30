<script setup lang="ts">
import type { AuditEntry } from '../../../src/shared/api';
import { formatTime } from '../../core/format';
import { useResource } from './useResource';

const { data: entries, error } = useResource<AuditEntry[]>(() => '/api/gm/audit');
</script>

<template>
	<p v-if="error" class="error">{{ error }}</p>
	<p v-else-if="entries?.length === 0" class="muted">Nothing yet.</p>
	<table v-else-if="entries">
		<thead>
			<tr>
				<th>When</th>
				<th>Who</th>
				<th>Action</th>
				<th>Detail</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="(e, i) in entries" :key="i">
				<td>{{ formatTime(e.at) }}</td>
				<td>{{ e.actor }}</td>
				<td>{{ e.action }}</td>
				<td>
					<code>{{ JSON.stringify(e.detail) }}</code>
				</td>
			</tr>
		</tbody>
	</table>
</template>

<style scoped>
code {
	word-break: break-all;
}
</style>
