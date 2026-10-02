// What the generic widgets share: the group chosen in a \`ui.filters\` and shown by the \`ui.cards\`
// with the same \`filter\` name (null = all).
import { reactive } from 'vue';

export const chosen = reactive<Record<string, string | null>>({});
