/** 匿名入口与真实 CAS 的只读浏览器验收，不输入学校凭据、不开启模拟器。 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = path.join(ROOT, 'docs/ui-preview');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://localhost:5173';
const CAPTCHA_FIXTURE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="52" viewBox="0 0 180 52"><rect width="180" height="52" rx="8" fill="#eef2ff"/><path d="M8 12L172 40M8 40L172 12" stroke="#a5b4fc" stroke-width="2"/><text x="90" y="35" text-anchor="middle" font-family="monospace" font-size="25" font-weight="700" letter-spacing="6" fill="#1e3a8a">A7K9</text></svg>').toString('base64')}`;
const viewports = {
  '1440x900': { width: 1440, height: 900 }, '1280x800': { width: 1280, height: 800 },
  '1024x768': { width: 1024, height: 768 }, '768x1024': { width: 768, height: 1024 },
  '430x932': { width: 430, height: 932 }, '390x844': { width: 390, height: 844 },
  '360x800': { width: 360, height: 800 }, '320x640': { width: 320, height: 640 },
};
const report = { generatedAt: new Date().toISOString(), browser: '', base: BASE,
  dataScope: '真实 CAS 模式下的匿名公开入口；不输入校园凭据。加载截图仅延迟真实会话响应；管理员第二阶段只使用隔离 UI fixture 展示验证码，不填写或提交管理员账号密码。',
  screenshots: [], checks: [], errors: [] };
const record = (condition, description) => { assert.ok(condition, description); report.checks.push(description); };
const save = () => fs.writeFileSync(path.join(OUT, 'entry-manifest.json'), JSON.stringify(report, null, 2) + '\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
report.browser = `Chrome ${browser.version()}`;
const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
page.on('pageerror', (error) => report.errors.push(error.message));
page.on('response', (response) => {
  const url = new URL(response.url());
  if (url.origin === new URL(BASE).origin && url.pathname.startsWith('/api/v1/') && response.status() >= 500) report.errors.push(`${url.pathname} HTTP ${response.status()}`);
});
async function navigate(pathname, theme, size) {
  await page.setViewportSize(viewports[size]);
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((mode) => localStorage.setItem('club-theme', mode), theme);
  await page.goto(`${BASE}${pathname}`, { waitUntil: 'networkidle' });
  await page.evaluate((mode) => {
    localStorage.setItem('club-theme', mode);
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, theme);
}
async function shot(name, description) {
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  record(layout.width <= layout.viewport + 1, `${name} 无整体横向溢出`);
  record(report.errors.length === 0, `${name} 无未捕获页面异常或 API 500`);
  const size = page.viewportSize();
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  report.screenshots.push({ file, viewport: `${size.width}×${size.height}`, theme: await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light'), description, path: new URL(page.url()).pathname });
  save();
  console.log(`✓ ${file}`);
}
async function anonymousCheck(name) {
  record(await page.getByRole('heading', { level: 1 }).innerText() === '欢迎来到大连外国语大学\nACM 社团', `${name} 标题保持指定文案`);
  record(await page.locator('aside').count() === 0, `${name} 未挂载私人侧边栏`);
  record(await page.locator('[data-slot="entry-brand"] img:visible').evaluate((img) => img.complete && img.naturalWidth === 595), `${name} 学校 Logo 正常加载且比例保留`);
}
async function checkLogoHome(name) {
  await page.getByRole('link', { name: '返回首页', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(`${BASE}/app`);
  await page.getByRole('button', { name: '校园 CAS 登录', exact: true }).waitFor();
  record(new URL(page.url()).pathname === '/app', `${name} 点击学校 Logo 和协会标识返回首页`);
}
try {
  for (const theme of ['light', 'dark']) {
    for (const size of Object.keys(viewports)) {
      await navigate('/app', theme, size);
      await page.getByRole('button', { name: '校园 CAS 登录', exact: true }).waitFor();
      await anonymousCheck(`entry-${theme}-${size}`);
      record(await page.getByRole('link', { name: '管理员登录', exact: true }).getAttribute('href') === '/admin/login', `entry-${theme}-${size} 提供独立管理员登录入口`);
      await shot(`entry-${theme}-${size}`, '新版插画社团入口；真实匿名会话，不挂载业务导航');
    }
    for (const size of ['1440x900', '430x932', '390x844', '320x640']) {
      await navigate('/login', theme, size);
      record(await page.getByText('使用学校统一认证登录协会系统。', { exact: true }).count() === 1, `登录页 ${theme}/${size} 保留指定说明`);
      record(!/本站不收集你的/.test(await page.locator('body').innerText()), `登录页 ${theme}/${size} 已删密码说明`);
      record(await page.getByRole('button', { name: /返回/ }).count() === 1, `登录页 ${theme}/${size} 有返回按钮`);
      if (viewports[size].width < 768) {
        const action = await page.getByRole('button', { name: '使用校园 CAS 登录', exact: true }).boundingBox();
        record(action.y + action.height <= viewports[size].height, `登录页 ${theme}/${size} 首屏可见主要登录操作`);
      }
      await shot(`entry-login-${theme}-${size}`, '登录返回按钮与官方 Logo；真实校园 CAS 入口');
      await checkLogoHome(`登录页 ${theme}/${size}`);
      await navigate('/register', theme, size);
      record(await page.getByRole('button', { name: /返回/ }).count() === 1, `注册页 ${theme}/${size} 有返回按钮`);
      record(await page.getByText('验证邀请', { exact: true }).isVisible()
        && await page.getByText('校园认证', { exact: true }).isVisible()
        && await page.getByText('提交申请', { exact: true }).isVisible(), `注册页 ${theme}/${size} 三个步骤均显示名称`);
      if (viewports[size].width < 768) {
        const action = await page.getByRole('button', { name: '扫描邀请码', exact: true }).boundingBox();
        record(action.y + action.height <= viewports[size].height, `注册页 ${theme}/${size} 首屏可见验证与扫码操作`);
      }
      await shot(`entry-register-${theme}-${size}`, '注册初始邀请输入步骤；无伪造邀请或认证');
      await checkLogoHome(`注册页 ${theme}/${size}`);
    }
  }
  for (const theme of ['light', 'dark']) {
    for (const size of ['1440x900', '430x932', '390x844', '320x640']) {
      await navigate('/admin', theme, size);
      await page.waitForURL(`${BASE}/admin/login`);
      record(await page.getByRole('heading', { name: '管理员登录', exact: true }).isVisible(), `管理员登录 ${theme}/${size} 显示独立入口`);
      record(await page.getByLabel('管理入口密语', { exact: true }).isVisible(), `管理员登录 ${theme}/${size} 首步仅要求密语`);
      record(await page.getByLabel('管理员用户名', { exact: true }).count() === 0, `管理员登录 ${theme}/${size} 密语通过前不显示账号表单`);
      record(await page.getByRole('button', { name: /返回/ }).count() === 1, `管理员登录 ${theme}/${size} 有返回按钮`);
      await shot(`entry-admin-login-${theme}-${size}`, '独立管理员登录初始密语步骤；未提交任何账号或密码');
    }
  }
  await page.route('**/api/v1/auth/admin/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/auth/admin/gate')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { verified: true }, meta: null }) });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/auth/admin/captcha')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { challengeId: 'ui-fixture-challenge', imageDataUrl: CAPTCHA_FIXTURE }, meta: null }) });
      return;
    }
    await route.abort();
  });
  try {
    for (const [theme, size] of [['light', '1440x900'], ['dark', '390x844']]) {
      await navigate('/admin/login', theme, size);
      await page.getByLabel('管理入口密语', { exact: true }).fill('ui-fixture-gate-secret');
      await page.getByRole('button', { name: '验证密语', exact: true }).click();
      await page.getByLabel('管理员用户名', { exact: true }).waitFor();
      record(await page.getByLabel('管理员密码', { exact: true }).isVisible(), `管理员登录第二步 ${theme}/${size} 显示密码字段`);
      record(await page.getByRole('img', { name: '管理员登录验证码', exact: true }).isVisible(), `管理员登录第二步 ${theme}/${size} 显示服务端验证码`);
      record(await page.getByRole('button', { name: '刷新验证码', exact: true }).isVisible(), `管理员登录第二步 ${theme}/${size} 可刷新验证码`);
      await shot(`entry-admin-credentials-fixture-${theme}-${size}`, '管理员登录账号与验证码步骤；使用隔离 UI fixture，未填写或提交账号密码');
    }
  } finally {
    await page.unroute('**/api/v1/auth/admin/**');
  }
  for (const [theme, size] of [['dark', '1440x900'], ['light', '390x844']]) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/v1/auth/csrf', async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    try {
      await page.setViewportSize(viewports[size]);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((mode) => localStorage.setItem('club-theme', mode), theme);
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('status').filter({ hasText: '正在确认登录状态' }).waitFor();
      record(await page.locator('[data-slot="entry-actions"]').count() === 0, `加载 ${theme}/${size} 会话确认前不显示匿名入口`);
      record(await page.getByRole('heading', { level: 1 }).count() === 0, `加载 ${theme}/${size} 会话确认前不显示欢迎首页`);
      record(await page.locator('aside').count() === 0, `加载 ${theme}/${size} 会话确认前不显示私人侧栏`);
      await shot(`entry-loading-${theme}-${size}`, '延迟实际匿名会话响应；独立登录状态加载界面，确认后才显示匿名首页');
      release();
      await page.getByRole('button', { name: '校园 CAS 登录', exact: true }).waitFor();
      await anonymousCheck(`entry-resolved-${theme}-${size}`);
    } finally {
      release();
      await page.unroute('**/api/v1/auth/csrf');
    }
  }
  // 真实前端按钮发起 CAS：只查看学校登录表单，不填写、提交凭据。
  await navigate('/app', 'light', '390x844');
  await page.getByRole('button', { name: '校园 CAS 登录', exact: true }).click();
  await page.waitForURL((url) => url.hostname === 'cas.dlufl.edu.cn' && url.pathname === '/cas/login', { timeout: 30_000 });
  const loginUrl = new URL(page.url());
  const service = new URL(loginUrl.searchParams.get('service'));
  record(service.origin === new URL(BASE).origin && service.pathname === '/api/v1/auth/cas/callback' && Boolean(service.searchParams.get('flow')), '手机首页主按钮一次操作直接跳转学校 CAS，service 指向本站精确绑定回调');
  await page.locator('input[type="password"]').first().waitFor({ timeout: 30_000 });
  record(true, '实际学校登录页已显示密码表单；未填写、未提交任何学校凭据');
  service.searchParams.set('ticket', 'ST-club-readonly-invalid-browser-check');
  const invalidTicket = await context.request.get(service.toString(), { maxRedirects: 0 });
  record(invalidTicket.status() === 302 && invalidTicket.headers().location === '/login?error=CAS_AUTH_FAILURE', '真实绑定回调向学校验票并拒绝合成无效票，清理后返回登录错误页');
  await navigate('/login?error=CAS_AUTH_FAILURE', 'light', '390x844');
  await page.getByRole('alert').waitFor();
  await shot('entry-login-cas-error-light-390', '真实学校拒绝合成票据后的中文错误说明；未建立会话');
  record(report.errors.length === 0, '本次匿名与真实 CAS 浏览器检查无页面异常');
  save();
  console.log(`完成 ${report.screenshots.length} 张匿名/加载截图，${report.checks.length} 项检查。`);
} catch (error) {
  report.errors.push(error.message);
  save();
  throw error;
} finally {
  await browser.close();
}
