// Trade routes (docs/design/gameplay.md §17.2, 17.3): the page with the routes' old maps, the team, its fights and the
// merchants ("trade-routes.page", declared by the server plugin), and a trade post's orders ("trade-routes.post", in the
// entry of the building a content plugin makes the trade post).
import { defineClientPlugin } from '../../core/game';
import Page from './Page.vue';
import Post from './Post.vue';

import type { PortraitArt } from './plan';

/** The people of the routes' stories: their art comes from client content plugins (nodes name them by id). */
export interface TradeRoutesClientService {
	addPortrait(id: string, art: PortraitArt): void;
	portrait(id: string): PortraitArt | undefined;
	/** Faces for everyone without a portrait of their own (heroes, enemy generals), by a seed: a client content plugin's. */
	setFaces(draw: (seed: string, gender?: 'm' | 'f') => PortraitArt): void;
	face(seed: string, gender?: 'm' | 'f'): PortraitArt | undefined;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		tradeRoutes: TradeRoutesClientService;
	}
}

export default defineClientPlugin({
	id: 'trade-routes',
	setup(game) {
		const portraits = new Map<string, PortraitArt>();
		let faces: ((seed: string, gender?: 'm' | 'f') => PortraitArt) | null = null;
		game.provide('tradeRoutes', {
			addPortrait: (id, art) => void portraits.set(id, art),
			portrait: (id) => portraits.get(id),
			setFaces: (draw) => void (faces = draw),
			face: (seed, gender) => faces?.(seed, gender),
		});
		game.messages('en', {
			'kind:start': 'Starting point',
			'kind:enemy': 'Enemy camp',
			'kind:boss': 'Chapter boss',
			'kind:supply': 'Supply point',
			'kind:merchant': 'Merchant',
			'kind:key': 'Key place',
			'kind:story': 'Story',
		});
		game.messages('zh-CN', {
			'kind:start': '起点',
			'kind:enemy': '敌营',
			'kind:boss': '本章首领',
			'kind:supply': '修整点',
			'kind:merchant': '商人',
			'kind:key': '关键节点',
			'kind:story': '奇闻',
			', ': '、',
			'Loading…': '加载中…',
			'No trade routes yet.': '还没有商路。',
			'{done} / {of} places · chapter {n}': '已开拓 {done} / {of} 处 · 第 {n} 章',
			'Solid paths are opened: walking them takes a third of the stamina.': '实线是已经开拓的路，走它只要三分之一的体力。',
			'The team': '开拓队',
			'Stamina {n}': '体力 {n}',
			'home at {at}': '{at} 回城',
			'no men left': '兵已打光',
			'Watch the last fight': '回看上一战',
			'Sure? The budget is not given back': '确定吗？预算不退',
			'Call home': '召回',
			'Calling the team home…': '召回中…',
			'On the way home: back at {at}': '返程中，{at} 回城',
			'Stop and call home: the team should be back at {at}': '停止探索并召回后，部队预计 {at} 返回出发城池',
			'How long the way home takes goes by the stamina spent.': '预计返回时长与已消耗体力值有关。',
			'Guards bar the way: beat them to learn what is here.': '有守军挡路：打败他们，才知道这里有什么。',
			'Each time out, passing by: {text}': '此后每次出门路过：{text}',
			'won in a fight': '战斗中获得',
			'Chapter {n}': '第 {n} 章',
			'Send a team out on {route}': '组队开拓{route}',
			From: '出发城池',
			'No free hero in this settlement.': '这座城没有空闲的英雄。',
			'Hero…': '选择英雄…',
			'Lv {n}': '{n} 级',
			'leads {n}': '带兵 {n}',
			'aim {n}%': '识破 {n}%',
			'{name} · Lv {level} {build}: {attrs} · aim {aim}%': '敌将{name} · {level} 级{build}：{attrs} · 识破 {aim}%',
			'No one leads them': '群龙无首',
			'Arm…': '选择兵种…',
			'{n} / {cap} men': '共 {n} / {cap} 人',
			Most: '最多',
			'Add a hero': '添加英雄',
			Budget: '预算',
			'{n} h': '{n} 小时',
			'Upkeep for the budget:': '预算（维持费）：',
			'carry {carry} / {load}': '载重 {carry} / {load}',
			'Choose a hero and the men it leads.': '请选择英雄和他带的兵。',
			'A hero only once.': '同一名英雄只能选一次。',
			'More men than the hero leads or the garrison has.': '超过了英雄的带兵上限或驻军数量。',
			'They cannot carry the budget: take supply trains along.': '载重不够装下预算：带上辎重队。',
			'Set out': '出发',
			'Setting out…': '出发中…',
			cleared: '已开拓',
			'Enemy columns, front first ({n} fight at once)': '敌军各路（前排在先，同时交战 {n} 路）',
			'Opened for trade': '已开通的贸易',
			'Clearing it opens for trade': '开拓后开通的贸易',
			'{to} {n} a day, for {from}': '每天用{from}换{to} {n}',
			'{n} points off the loss': '损耗降低 {n} 点',
			'Go there (stamina {n})': '前往（体力 {n}）',
			'Who fights (at most {n}):': '出战（最多 {n} 路）：',
			'Fight (stamina {n})': '进攻（体力 {n}）',
			'Not enough stamina.': '体力不够。',
			"Today's goods": '今日货品',
			'Sold out': '已售罄',
			Buy: '购买',
			'On the way…': '行进中…',
			'Fighting…': '交战中…',
			'Buying…': '购买中…',
			'Enemy column {n}': '敌军第 {n} 路',
			Miss: '落空',
			'Round {n}': '第 {n} 回合',
			'{n} more columns behind': '后面还有 {n} 路',
			Skip: '跳过',
			Again: '重播',
			Close: '关闭',
			'Victory: the place is cleared.': '胜利：此地已开拓。',
			'Beaten back.': '败退。',
			'{hero} lost {men}': '{hero}损失：{men}',
			'{before} fallen, {after} lost': '阵亡 {before}，实际损失 {after}',
			'Each hero who fought: {n} experience': '出战英雄各得经验 {n}',
			'{hero} has an epiphany: {n} free points': '{hero}顿悟：自由属性点 +{n}',
			Trade: '互市',
			'A deal takes {t} here (trade speed +{s}%) · loss {l}%': '每笔交易用时 {t}（交易速度 +{s}%）· 损耗 {l}%',
			'No trade orders yet: clear the key places on the trade routes.': '还没有商单：开拓商路上的关键节点后开通。',
			for: '换',
			'Done today': '今日已做',
			'Trading…': '交易中…',
		});
		game.widget('trade-routes.page', Page);
		game.widget('trade-routes.post', Post);
	},
});
