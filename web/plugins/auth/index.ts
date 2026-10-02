// Login / invite-only registration. Logged out: gates the whole UI with the auth screen.
// Logged in: provides the "auth" service and a user box in the top band (with changing the password);
// logged in with an initial password (the GM's first login), only the screen to change it.
import type { User } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import AuthScreen from './AuthScreen.vue';
import PasswordScreen from './PasswordScreen.vue';
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
			'Change password': '修改密码',
			'Current password': '当前密码',
			'New password': '新密码',
			'New password again': '再次输入新密码',
			'8-128 characters': '8–128 个字符',
			'The new passwords do not match': '两次输入的新密码不一致',
			'Password changed': '密码已修改',
			Cancel: '取消',
			'{name}: you logged in with the initial password. Choose your own before going on.':
				'{name}：你使用的是初始密码登录，请先设置自己的密码再继续。',
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
		if (user.mustChangePassword) return game.gate(PasswordScreen);
		// In the top band (server-declared); widgets in the "user-actions" slot show right of the name.
		game.widget('auth.user', UserBox);
	},
});
