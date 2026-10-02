// The frame's words (the core's, not a plugin's): the layout, a few generic formats and the kernel's errors
// (they have no plugin). Content names, form texts and server messages ship with their server plugins
// (their data/i18n.csv, served in meta "i18n"); each client plugin registers its own words (`game.messages`).
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
	// The kernel's errors (requests, rules a GM edits).
	'"{0}": {1}': '"{0}"：{1}',
	'Expected a number between {0} and {1}': '应为 {0} 到 {1} 之间的数字',
	'Expected an object': '应为对象',
	'Expected an object of numbers': '应为数值组成的对象',
	'Request body must be valid JSON': '请求体必须是有效的 JSON',
	'Unknown command "{0}"': '未知命令"{0}"',
	'Unknown config key "{0}"': '未知规则"{0}"',
	'Unknown field "{0}" (known: {1})': '未知字段"{0}"（可用：{1}）',
	'Unknown id "{0}" (known: {1})': '未知 id"{0}"（可用：{1}）',
	'Unknown report "{0}"': '未知报表"{0}"',
};

export const frameMessages: Record<string, Record<string, string>> = { 'zh-CN': zh };
