// State shared by the mail plugin's own components.
import { ref } from 'vue';
import type { MailHeader, MailMessage } from '../../../src/shared/api';
import { ApiError } from '../../core/api';
import type { Game } from '../../core/game';

/** The message open on the Mail page. */
export const selected = ref<string | null>(null);
/**
 * Older pages fetched on demand (page 1 is the live `mail.inbox` view): `pages[i]` is page i + 2.
 * `page` is the page shown, 0 = the newest.
 */
export const pages = ref<{ messages: MailHeader[]; more: boolean }[]>([]);
export const page = ref(0);

/**
 * Messages whole, by id: what a message says never changes, so each is fetched once, when first opened — at its own
 * address, which the browser's HTTP cache keeps for good (a reload asks again, and the browser answers it).
 */
export const bodies = ref<Record<string, MailMessage | null>>({});
const fetching = new Set<string>();
export async function fetchBody(game: Game, id: string) {
	if (id in bodies.value || fetching.has(id)) return;
	fetching.add(id);
	try {
		let body: MailMessage | null;
		try {
			body = await game.request<MailMessage>(`/api/mail/${encodeURIComponent(id)}`);
		} catch (err) {
			if (!(err instanceof ApiError && err.status === 404)) throw err;
			body = null;
		}
		bodies.value = { ...bodies.value, [id]: body };
	} finally {
		fetching.delete(id);
	}
}
