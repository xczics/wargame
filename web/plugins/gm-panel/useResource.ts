import { onActivated, ref, shallowRef } from 'vue';
import { useGame } from '../../core/game';
import { errorText } from '../../core/api';

/**
 * Load a GM endpoint when the tab is shown (also on first mount: tabs live in <KeepAlive>)
 * and again every time it becomes visible; call `reload()` after mutations.
 */
export function useResource<T>(path: () => string) {
	const game = useGame('gm-panel');
	const data = shallowRef<T | null>(null);
	const error = ref('');
	async function reload() {
		try {
			data.value = await game.request<T>(path());
			error.value = '';
		} catch (err) {
			error.value = errorText(err);
		}
	}
	onActivated(reload);
	return { data, error, reload };
}

export async function copyText(text: string, toast: (m: string, k?: 'info' | 'error') => void) {
	try {
		await navigator.clipboard.writeText(text);
		toast('Copied', 'info');
	} catch {
		prompt('Copy this:', text);
	}
}
