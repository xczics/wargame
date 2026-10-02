// Server texts are i18n keys "<pluginId>.<key>" (src/plugins/i18n). A plugin's views send their own texts
// without the prefix: they belong to the plugin that owns the view ("buildings.slots" -> buildings).
// Texts of other plugins (content names, a hook's lines) come as registered keys and are left alone.
import { mapUiTexts } from '../../src/shared/i18n';

/** Every view of a state, its UiTexts prefixed with the plugin in its id (unless already a key). */
export function ownViews(views: Record<string, unknown>, isKey: (text: string) => boolean): void {
	for (const [id, v] of Object.entries(views)) {
		const owner = id.slice(0, id.indexOf('.'));
		mapUiTexts(v, (s) => (s && !isKey(s) ? `${owner}.${s}` : s));
	}
}
