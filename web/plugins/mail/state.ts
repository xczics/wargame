// State shared by the mail plugin's own components.
import { ref } from 'vue';
import type { MailMessage } from '../../../src/shared/api';

/** The message open on the Mail page. */
export const selected = ref<string | null>(null);
/**
 * Older pages fetched on demand (page 1 is the live `mail.inbox` view): `pages[i]` is page i + 2.
 * `page` is the page shown, 0 = the newest.
 */
export const pages = ref<{ messages: MailMessage[]; more: boolean }[]>([]);
export const page = ref(0);
