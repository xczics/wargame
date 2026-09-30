// Login / invite-only registration. Logged out: gates the whole UI with the auth screen.
// Logged in: provides the "auth" service and a user box in the top bar.
import type { User } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import AuthScreen from './AuthScreen.vue';
import UserBox from './UserBox.vue';

export interface AuthService {
	user: User;
	logout(): Promise<void>;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		auth: AuthService;
	}
}

export default defineClientPlugin({
	id: 'auth',
	async setup(game) {
		game.messages('zh-CN', {
			Username: '用户名',
			Password: '密码',
			'Invite code': '邀请码',
			'Create account': '注册',
			'Log in': '登录',
			'Log out': '退出',
			'Already have an account? Log in': '已有账号？去登录',
			'Have an invite code? Register': '有邀请码？去注册',
		});
		const { user } = await game.request<{ user: User | null }>('/api/auth/me');
		if (!user) return game.gate(AuthScreen);

		game.provide('auth', {
			user,
			async logout() {
				await game.request('/api/auth/logout', { method: 'POST' });
				location.reload();
			},
		});
		game.slot('top', UserBox, { order: -10 });
	},
});
