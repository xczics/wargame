// The GM's announcement as a banner on every page (`mail.announcement`, generic `ui.banner`), assembled in the browser
// (AGENTS.md: the server sends data only) from the announcement's text (`mail.notice`). Pure: the tests run it.
import type { MailNotice } from '../../../src/shared/api';
import { uiTexts } from '../../../src/shared/i18n';
import type { BannerData } from '../../../src/shared/ui';

// The mail plugin's own words (its i18n keys): the banner reads as it did when the server built it.
const text = uiTexts('mail');

export function announcementBanner(notice: MailNotice | null | undefined): BannerData | null | undefined {
	// Its text is the key: a new announcement shows again after the player closed the last one.
	return notice ? { text: text('{0}', { 0: notice.text }), icon: '📢', key: notice.text } : notice;
}
