// State shared by the mail plugin's own components.
import { ref } from 'vue';
import type { ClientState, MailHeader, MailMessage } from '../../../src/shared/api';
import type { Game } from '../../core/game';

/** The message open on the Mail page. */
export const selected = ref<string | null>(null);
/**
 * Older pages fetched on demand (page 1 is the live `mail.inbox` view): `pages[i]` is page i + 2.
 * `page` is the page shown, 0 = the newest.
 */
export const pages = ref<{ messages: MailHeader[]; more: boolean }[]>([]);
export const page = ref(0);

/** Messages whole, by id: what a message says never changes, so each is fetched once, when first opened. */
export const bodies = ref<Record<string, MailMessage | null>>({});
const fetching = new Set<string>();
export async function fetchBody(game: Game, id: string) {
	if (id in bodies.value || fetching.has(id)) return;
	fetching.add(id);
	try {
		const q = new URLSearchParams({ views: 'mail.message', mail: id });
		const state = await game.request<ClientState>(`/api/state?${q}`);
		bodies.value = { ...bodies.value, [id]: (state.views['mail.message'] as MailMessage | null) ?? null };
	} finally {
		fetching.delete(id);
	}
}
