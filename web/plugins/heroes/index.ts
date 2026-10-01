// Heroes: the Heroes page (my heroes, candidates, defence order) and the candidates on the
// buildings where heroes are recruited (which buildings those are comes from the server).
import { watch } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import CandidatesBlock from './CandidatesBlock.vue';
import DefenseBlock from './DefenseBlock.vue';
import HeroList from './HeroList.vue';
import PostsBlock from './PostsBlock.vue';

export interface HeroesService {
	/** A hero's name in the current language (parts are spelled per locale by the server's data). */
	name(hero: { surname: string; given: string }): string;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		heroes: HeroesService;
	}
}

export default defineClientPlugin({
	id: 'heroes',
	dependsOn: ['settlement', 'forms'],
	setup(game) {
		game.messages('zh-CN', {
			Heroes: '英雄',
			'My heroes': '我的英雄',
			'No heroes yet. Recruit them at a tavern, academy or music house.': '还没有英雄。可以在酒馆、书院或听曲楼招募。',
			Candidates: '候选',
			'New candidates in {t}': '{t} 后刷新',
			Recruit: '招募',
			Recruited: '已招募',
			'Nobody this time': '本轮无人',
			'No recruiting buildings here.': '此城没有招募英雄的建筑。',
			Duty: '职务',
			At: '地点',
			Assign: '委派',
			'Attached to': '挂靠',
			Move: '改挂靠',
			Dismiss: '遣散',
			'Let {name} go?': '遣散{name}？',
			'Defence order': '守城顺序',
			'The first heroes here that are in town defend this settlement; the rest are substitutes.':
				'排在前面且在城中的英雄负责守城，其余为替补。',
			'Strongest first (not set).': '未设置：按武力、统率、智谋之和排序。',
			Save: '保存',
			Reset: '恢复默认',
			'No heroes attached here.': '没有挂靠在此城的英雄。',
			'Heroes of this settlement': '本城英雄',
			'Heroes here': '驻守英雄',
			Defending: '守城武将',
			'Nobody.': '无人。',
			'Assign heroes': '去委派英雄',
			'at {place}': '于{place}',
			'{name} will leave the post of {duty} there.': '改挂靠后，{name}将卸任原城池的"{duty}"职务。',
			'A hero serves only in the settlement it is attached to': '英雄只能在挂靠的城池任职',
			'That hero is busy with another duty': '该英雄正在担任其他职务',
			'effect:production': '产出',
			'effect:construction': '建造时间',
			'effect:training': '训练时间',
			'effect:upkeep': '部队维持',
			'effect:research': '科研时间',
			'effect:attack': '攻击',
			'effect:defense': '防御',
			'effect:hp': '生命',
			'effect:casualty': '伤亡',
		});
		const names = game.meta.heroNames ?? {};
		const spell = (key: string) => names[game.locale.value]?.[key] ?? names.en?.[key] ?? key;
		const name = (h: { surname: string; given: string }) =>
			game.locale.value.startsWith('zh') ? `${spell(h.surname)}${spell(h.given)}` : `${spell(h.surname)} ${spell(h.given)}`;
		game.provide('heroes', { name });

		game.need('heroes.list', 'heroes.candidates', 'heroes.defense', 'starter-heroes.posts');
		// Server forms (e.g. marching out) label heroes with their English spelling: translate those too.
		watch(
			() => game.view('heroes.list'),
			(list: HeroInfo[] | undefined) => {
				const en = (h: HeroInfo) => `${names.en?.[h.surname] ?? h.surname} ${names.en?.[h.given] ?? h.given}`;
				for (const locale of Object.keys(names))
					if (locale !== 'en') game.messages(locale, Object.fromEntries((list ?? []).map((h) => [en(h), name(h)])));
			},
			{ immediate: true },
		);
		// New candidates arrive at a known time.
		watch(
			() => Math.min(...(game.view('heroes.candidates') ?? []).map((v) => v.refreshesAt)),
			(t) => Number.isFinite(t) && game.refreshAt(t),
		);

		game.page('heroes', 'Heroes', { order: 6 });
		game.block('heroes', 'left', HeroList);
		game.block('heroes', 'right', CandidatesBlock);
		game.block('heroes', 'right', DefenseBlock, { order: 10 });
		// Posts: the city page shows the settlement's own; buildings with posts (e.g. the institute) show theirs.
		game.block('city', 'left', PostsBlock, { order: 20 });
		game.entryBlock('building', PostsBlock);
		const venueBuildings = (game.meta.heroes?.venues ?? []).map((v) => v.building);
		if (venueBuildings.length) game.entryBlock('building', CandidatesBlock, { types: venueBuildings });
	},
});
