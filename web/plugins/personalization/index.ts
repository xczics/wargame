// Personalization: applies what the GM chose for the site (static view "personalization.site": the tab's icon and title)
// and draws the GM's tab for it (widget "personalization.gm", in the GM console's slot "gm-tabs"). First of the client
// plugins, before the login screen gates the rest: what was applied last time is applied at once from this browser's
// storage, so the login screen has the GM's icon too; the static view (only after logging in) brings changes.
import { watch } from 'vue';
import type { PersonalizationSite, PersonalizationValue } from '../../../src/shared/api';
import { defineClientPlugin, type Game } from '../../core/game';
import GmPersonalization from './GmPersonalization.vue';

export interface PersonalizationClient {
	/** A field's value now, by its rule's key (e.g. "personalization.icon"); reactive. Undefined until it arrives. */
	value(key: string): PersonalizationValue | undefined;
	/** Where an image value is. */
	url(value: PersonalizationValue): string | undefined;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		personalization: PersonalizationClient;
	}
}

const STORE = 'wargame.personalization';
/** What the page came with (index.html), for when the GM clears a field. */
const builtIn = { icon: '/favicon.svg', title: document.title };
const TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', ico: 'image/x-icon' };

interface Applied {
	icon?: string;
	title?: string;
}

function apply({ icon, title }: Applied) {
	const href = icon || builtIn.icon;
	const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
	if (links.length !== 1 || links[0].getAttribute('href') !== href) {
		// One link only: a browser keeps using any other (e.g. the .ico fallback) over the new one.
		links.forEach((l) => l.remove());
		const link = document.createElement('link');
		link.rel = 'icon';
		link.href = href;
		const type = TYPES[/\.([a-z]+)$/.exec(href)?.[1] ?? ''];
		if (type) link.type = type;
		document.head.appendChild(link);
	}
	document.title = title || builtIn.title;
}

function remembered(): Applied | null {
	try {
		return JSON.parse(localStorage.getItem(STORE) ?? 'null') as Applied | null;
	} catch {
		return null;
	}
}
function remember(applied: Applied) {
	try {
		localStorage.setItem(STORE, JSON.stringify(applied));
	} catch {
		// Private windows and the like: the login screen shows the built-in icon.
	}
}

const urlOf = (game: Game, v: PersonalizationValue) => ('url' in v ? v.url : 'file' in v ? game.fileUrl(v.file) : undefined);

export default defineClientPlugin({
	id: 'personalization',
	setup(game) {
		game.messages('zh-CN', {
			'Loading…': '加载中…',
			'Built in': '内置',
			Uploaded: '已上传',
			'Upload a picture': '上传图片',
			'PNG, SVG, WebP or ICO, at most {kb} KB; square pictures look best. SVG: drawings only (no scripts or links).':
				'PNG、SVG、WebP 或 ICO，最大 {kb} KB；正方形效果最好。SVG 只能是纯图形（不能有脚本或链接）。',
			'No file bucket here: only the built-in icons.': '这里没有文件存储，只能用内置图标。',
			'In use': '使用中',
			Use: '使用',
			'Back to the default': '恢复默认',
			Save: '保存',
			Saved: '已保存',
			'Picture uploaded': '图片已上传',
			"Empty: the game's own title": '留空：使用游戏自带的标题',
			'Players see changes with their next sync (within a minute).': '玩家在下次同步（一分钟内）后看到改动。',
		});
		const saved = remembered();
		if (saved) apply(saved);

		const site = () => game.static<PersonalizationSite>('personalization.site');
		game.provide('personalization', {
			value: (key) => site()?.[key],
			url: (v) => urlOf(game, v),
		});
		watch(site, (values) => {
			if (!values) return;
			const icon = values['personalization.icon'];
			const title = values['personalization.title'];
			const applied: Applied = {
				icon: icon && urlOf(game, icon),
				title: title && 'text' in title ? title.text : undefined,
			};
			apply(applied);
			remember(applied);
		});
		// Only the GM's console has the slot it goes in.
		game.widget('personalization.gm', GmPersonalization);
	},
});
