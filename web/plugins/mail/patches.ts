// What the mail's commands did, in the inbox held in the browser (`game.patchView`). Pure: the tests run it.
import type { MailInbox } from '../../../src/shared/api';

/** A message's attachments claimed (and it read, as the server marks it). */
export function claimed(inbox: MailInbox, id: string): MailInbox {
	if (!inbox.messages.some((m) => m.id === id && m.gift === 'unclaimed')) return inbox;
	return { ...inbox, messages: inbox.messages.map((m) => (m.id === id ? { ...m, gift: 'claimed' as const, read: true } : m)) };
}
