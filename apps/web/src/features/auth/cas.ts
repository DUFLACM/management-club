import { api, fetchCsrfToken, ApiError } from '@/lib/api';

/**
 * 校园 CAS 登录发起（登录页与注册页共用）。
 *
 * 流程：先 GET /auth/csrf 取匿名绑定/会话绑定的 CSRF token，
 * 再 POST /auth/cas/start（携带 X-Clubs-Csrf），成功后用返回的
 * redirectUrl 做**顶层导航**（window.location.href），不在 SPA 内跳转。
 * 前端不收集学校密码；CAS 超时/取消由学校端提供重试。
 */
export async function startCasLogin(options: {
  purpose?: 'login' | 'register';
  registrationIntentId?: string;
} = {}): Promise<void> {
  await fetchCsrfToken();
  const { data } = await api.post<{ redirectUrl?: string }>('/auth/cas/start', options);
  const redirectUrl = data?.redirectUrl;
  if (!redirectUrl) {
    throw new ApiError('CAS_START_FAILED', '服务端未返回学校认证跳转地址，请重试。');
  }
  window.location.href = redirectUrl;
}
