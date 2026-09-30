<script setup lang="ts">
// Server forms placed on an entry: placement = the entry kind, and the entry's data plus its
// type (e.g. settlement, district, slot, type = building) go along as context for prepare().
import { computed } from 'vue';
import type { Entry } from '../../core/game';
import FormOutlet from './FormOutlet.vue';

const props = defineProps<{ entry: Entry }>();
const context = computed(() => ({ ...props.entry.data, ...(props.entry.type ? { type: props.entry.type } : {}) }));
</script>

<template>
	<FormOutlet :placement="entry.kind" :context="context" />
</template>
