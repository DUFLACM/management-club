import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import {
  AdminLoginPage,
  adminLoginNextTarget,
  captchaImageSource,
} from './AdminLoginPage';

describe('admin login page', () => {
  it('shows only the gate-secret stage before the gate is verified', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AdminLoginPage />
      </MemoryRouter>,
    );

    expect(html).toContain('管理员登录');
    expect(html).toContain('管理入口密语');
    expect(html).toContain('验证密语');
    expect(html).not.toContain('管理员用户名');
    expect(html).not.toContain('管理员密码');
    expect(html).not.toContain('管理员登录验证码');
  });

  it('accepts only supported captcha image sources', () => {
    expect(captchaImageSource({
      challengeId: 'challenge-1',
      imageDataUrl: 'data:image/png;base64,abc',
    })).toBe('data:image/png;base64,abc');
    expect(captchaImageSource({
      challengeId: 'challenge-2',
      imageUrl: '/api/v1/auth/admin/captcha/challenge-2/image',
    })).toBe('/api/v1/auth/admin/captcha/challenge-2/image');
    expect(captchaImageSource({
      challengeId: 'challenge-3',
      imageUrl: 'https://untrusted.example/captcha.png',
    })).toBeNull();
  });

  it('keeps successful redirects inside the management workspace', () => {
    expect(adminLoginNextTarget('/admin?section=members')).toBe('/admin?section=members');
    expect(adminLoginNextTarget('/app')).toBe('/admin');
    expect(adminLoginNextTarget('https://example.com')).toBe('/admin');
  });
});
