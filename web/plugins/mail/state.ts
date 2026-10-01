// State shared by the mail plugin's own components.
import { ref, type Component } from 'vue';

/** Renderers by message kind. */
export const renderers = new Map<string, Component>();
/** The message open on the Mail page. */
export const selected = ref<string | null>(null);
