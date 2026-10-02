// The Items page: the category filter (null = all) and the item opened on the right (null = the grid).
import { ref } from 'vue';

export const category = ref<string | null>(null);
export const picked = ref<string | null>(null);
