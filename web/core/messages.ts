// The frame's words (the core's, not a plugin's): the layout and a few generic formats. The kernel's errors
// are server texts like any plugin's ("kernel.<key>", src/kernel/i18n.csv). Content names, form texts and server messages ship with their server plugins
// (their data/i18n.csv, served in meta "i18n"); each client plugin registers its own words (`game.messages`).
const zh: Record<string, string> = {
	Back: '返回',
	Done: '完成',
	OK: '好的',
	'{0}: working…': '{0}：处理中…',
	Copied: '已复制',
	'Too many simultaneous changes, please retry': '同时操作过多，请重试',
	'{0} ({1}) — {2}': '{0}（{1}）— {2}',
	'{0}, {1}': '{0}，{1}',
	free: '免费',
	auto: '自动',
	'That hero is away': '该英雄不在城中',
};

export const frameMessages: Record<string, Record<string, string>> = { 'zh-CN': zh };
