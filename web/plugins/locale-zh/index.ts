// Chinese for what belongs to no server plugin: the layout frame, the engine's retry message and a few
// generic formats. Content names, form texts and server messages ship with their server plugins
// (their data/i18n.csv, served in meta "i18n"); each client plugin carries its own UI texts.
import { defineClientPlugin } from '../../core/game';

const zh: Record<string, string> = {
	Back: '返回',
	Done: '完成',
	Copied: '已复制',
	'Too many simultaneous changes, please retry': '同时操作过多，请重试',
	'{0} ({1}) — {2}': '{0}（{1}）— {2}',
	'{0}, {1}': '{0}，{1}',
	free: '免费',
	auto: '自动',
	'That hero is away': '该英雄不在城中',
};

export default defineClientPlugin({
	id: 'locale-zh',
	setup(game) {
		game.messages('zh-CN', zh);
	},
});
