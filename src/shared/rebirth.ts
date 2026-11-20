// Rebirth's words both ends use (docs/design/gameplay.md §17.1).
import { keyText } from './i18n';
import type { UiText } from './ui';

/**
 * The realm a hero is in by its rebirths, as a cultivator's (user 2026-11-20: "转生的状态写成练气->筑基->...  即没转生就是凡人，
 * 转生后是练气修士，再转生升级为筑基"): 0 a mortal, then Qi Refining, Foundation Building … the ninth Tribulation; past the
 * table (a GM's higher cap) the last. Names in the rebirth plugin's i18n.csv (realm:<n>).
 */
/** The rebirth pill's item id (its use: command "items.use.<id>"). */
export const PILL = 'rebirth-pill';

export const LAST_REALM = 9;
export const realmText = (rebirths: number): UiText => keyText(`rebirth.realm:${Math.max(0, Math.min(LAST_REALM, Math.floor(rebirths)))}`);
