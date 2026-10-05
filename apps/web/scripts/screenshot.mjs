/**
 * 真实浏览器验收：系统 Chrome，无需下载 Playwright 浏览器。
 * 前置：pnpm db:seed；pnpm --filter @acm/db seed:ui；API 与 web/preview :5173。
 * 可从仓库根目录或 apps/web 运行。Cookie、票据不写入产物。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = path.join(ROOT, 'docs/ui-preview');
const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://localhost:5173';
const envPath = path.join(ROOT, '.env');
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
if ((process.env.AUTH_DEV_SIMULATOR ?? env.AUTH_DEV_SIMULATOR) !== 'true') {
  throw new Error('业务截图仅用于显式开发 CAS 演示环境；真实 CAS 匿名验收请运行 scripts/entry-screenshot.mjs。');
}
const password = process.env.AUTH_DEV_SIMULATOR_PASSWORD ?? env.AUTH_DEV_SIMULATOR_PASSWORD;
if (!password) throw new Error('请在根 .env 配置开发 CAS 口令');
const fixture = JSON.parse(fs.readFileSync(path.join(OUT, 'fixture-context.json'), 'utf8'));
const viewports = {
  '1440x900': { width: 1440, height: 900 }, '1280x800': { width: 1280, height: 800 },
  '1024x768': { width: 1024, height: 768 }, '768x1024': { width: 768, height: 1024 },
  '430x932': { width: 430, height: 932 }, '390x844': { width: 390, height: 844 },
  '360x800': { width: 360, height: 800 }, '320x640': { width: 320, height: 640 },
};
const manifest = { generatedAt: new Date().toISOString(), browser: '', base: BASE, dataScope: fixture.dataScope,
  screenshots: [], checks: [], network: { overview: null }, errors: [] };
function saveManifest() {
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
function check(condition, description) {
  if (!condition) throw new Error(description);
  manifest.checks.push(description);
}
function observe(page) {
  page.on('pageerror', (error) => manifest.errors.push(error.message));
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/api/v1/') && response.status() >= 500) {
      manifest.errors.push(`${pathname} HTTP ${response.status()}`);
    }
  });
}
async function navigate(page, pathname, theme = 'light') {
  await page.goto(`${BASE}${pathname}`, { waitUntil: 'networkidle' });
  await page.evaluate((mode) => {
    localStorage.setItem('club-theme', mode);
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
}
async function shot(page, name, description) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const size = page.viewportSize();
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  check(layout.width <= layout.viewport + 1, `${name} 页面无整体横向溢出`);
  check(manifest.errors.length === 0, `${name} 无未捕获页面异常`);
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  manifest.screenshots.push({ file, viewport: `${size.width}×${size.height}`, theme: await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light'), description, path: new URL(page.url()).pathname + new URL(page.url()).search });
  saveManifest();
  console.log(`✓ ${file}`);
}
async function cas(page, studentNo, name) {
  await page.waitForURL(/dev-cas\/login/, { timeout: 15_000 });
  await page.locator('input[name=studentNo]').fill(studentNo);
  await page.locator('input[name=realName]').fill(name);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button').click();
}
async function login(page) {
  await navigate(page, '/login');
  await page.getByRole('button', { name: '使用校园 CAS 登录', exact: true }).click();
  await cas(page, '202600001', '林同学（演示）');
  await page.waitForURL(/\/app/, { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
}
async function post(context, endpoint, body) {
  const csrf = await (await context.request.get(`${BASE}/api/v1/auth/csrf`)).json();
  const response = await context.request.post(`${BASE}/api/v1${endpoint}`, {
    headers: { Origin: new URL(BASE).origin, 'X-Clubs-Csrf': csrf.data.token }, data: body,
  });
  const result = await response.json();
  if (!response.ok()) throw new Error(result.error?.message ?? `API ${endpoint} HTTP ${response.status()}`);
  return result.data;
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  manifest.browser = `Chrome ${browser.version()}`;
  try {
    const context = await browser.newContext({ viewport: viewports['1440x900'], deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai',
      permissions: ['geolocation'], geolocation: { latitude: fixture.latitude, longitude: fixture.longitude, accuracy: 5 } });
    const page = await context.newPage();
    observe(page);
    await login(page);
    check(true, '开发 CAS 登录通过真实 HTTP 建立会话');
    const apiResponses = [];
    const responseReads = [];
    const trackApi = (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/api/v1/')) {
        responseReads.push(response.body().then((body) => apiResponses.push({ path: pathname, status: response.status(), cacheControl: response.headers()['cache-control'], bytes: body.length })));
      }
    };
    page.on('response', trackApi);
    const overviewRequests = [];
    const trackOverview = (request) => overviewRequests.push(request.url());
    page.on('request', trackOverview);
    const overviewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/me/dashboard');
    await navigate(page, '/app?section=overview');
    page.off('request', trackOverview);
    await overviewResponse;
    page.off('response', trackApi);
    await Promise.all(responseReads);
    const externalOjRequests = overviewRequests.filter((url) => /(?:codeforces\.com|atcoder\.jp|nowcoder\.com|hydro\.example)/.test(new URL(url).hostname)).length;
    manifest.network.overview = { requests: apiResponses, privateBytes: apiResponses.reduce((total, item) => total + item.bytes, 0), externalOjRequests };
    check(externalOjRequests === 0, '概览未发出外部 OJ 请求');
    check(apiResponses.every((item) => item.status === 200 && item.cacheControl?.includes('no-store')), '概览私人 API 成功且均为 no-store');
    check(manifest.network.overview.privateBytes <= 50 * 1024, '概览私人响应合计不超过 50 KiB');
    check(apiResponses.some((item) => item.path === '/api/v1/auth/session'), '工作台身份来自真实 session');

    for (const theme of ['light', 'dark']) {
      for (const [workspace, sections] of [
        ['member', ['overview', 'activities', 'attendance', 'contests', 'points', 'ranking', 'profile']],
        ['admin', ['overview', 'members', 'activities', 'contests', 'points', 'rules', 'invites', 'sync', 'audit', 'settings']],
      ]) {
        for (const section of sections) {
          await navigate(page, `/${workspace === 'member' ? 'app' : 'admin'}?section=${section}`, theme);
          await shot(page, `${workspace}-${section}-${theme}-1440`, `${workspace === 'member' ? '成员' : '管理'}工作台 ${section}；本地演示数据库`);
        }
      }
    }
    for (const [viewport, theme] of [['1440x900', 'light'], ['390x844', 'light'], ['390x844', 'dark']]) {
      await page.setViewportSize(viewports[viewport]);
      const suffix = `${theme}-${viewport.split('x')[0]}`;
      await navigate(page, `/app?section=activities&activity=${fixture.activityId}`, theme);
      await page.getByRole('dialog').waitFor();
      await shot(page, `member-activity-detail-${suffix}`, '演示活动详情/本人报名；真实 API');
      await navigate(page, `/app?section=ranking&tab=frozen&ref=${fixture.freezeId}`, theme);
      await page.getByText('截图验收冻结榜（演示）').waitFor();
      await shot(page, `member-frozen-${suffix}`, '本地冻结榜 fixture；非真实赛事结果');
      await navigate(page, '/app?section=profile', theme);
      await page.getByRole('tab', { name: 'rating', exact: true }).click();
      await page.waitForLoadState('networkidle');
      await shot(page, `member-rating-${suffix}`, '个人平台 rating 无已核验绑定/记录，验收真实空态');
      await navigate(page, `/admin?section=activities&activity=${fixture.activityId}`, theme);
      await page.getByRole('button', { name: '现场码大屏' }).click();
      await page.getByRole('img', { name: '现场活动码' }).waitFor();
      await shot(page, `admin-qr-${suffix}`, '真实 API 签发的短期 IN 现场码；仅本地演示活动');
      await navigate(page, '/admin?section=activities&tab=venues', theme);
      await shot(page, `admin-venues-${suffix}`, '地点认证/运行状态；演示坐标，不代表现场认证');
    }
    for (const [size, viewport] of Object.entries(viewports)) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize(viewport);
        await navigate(page, '/app?section=overview', theme);
        await shot(page, `member-overview-${theme}-${size}`, '成员概览响应式布局；本地演示数据库');
      }
    }
    await page.setViewportSize(viewports['768x1024']);
    await navigate(page, '/app?section=overview');
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await shot(page, 'member-sidebar-expanded-light-768', '平板侧栏展开、导航分组与账户区');
    await page.setViewportSize(viewports['390x844']);
    await navigate(page, `/app?section=attendance&id=${fixture.activityId}`);
    await context.setGeolocation({ latitude: fixture.latitude + 0.1, longitude: fixture.longitude, accuracy: 5 });
    await page.getByRole('button', { name: '定位签到', exact: true }).click();
    await page.getByText('本次未通过核验', { exact: true }).waitFor();
    await shot(page, 'member-attendance-rejected-light-390', '真实 API 拒绝围栏外演示定位；未产生检查点');
    await context.setGeolocation({ latitude: fixture.latitude, longitude: fixture.longitude, accuracy: 5 });
    await page.getByRole('button', { name: '定位签到', exact: true }).click();
    await page.getByRole('button', { name: '签到 IN（已记录）', exact: true }).waitFor();
    await shot(page, 'member-attendance-in-light-390', '真实 IN accepted；浏览器定位为明确的演示坐标');
    await page.getByRole('button', { name: '签退 OUT', exact: true }).click();
    await page.getByRole('button', { name: '定位签退', exact: true }).click();
    await page.getByRole('button', { name: '签退 OUT（已记录）', exact: true }).waitFor();
    await shot(page, 'member-attendance-out-light-390', '真实 OUT accepted；等待认定，未声称获得积分');
    check(true, '围栏外拒绝→围栏内 IN→OUT 通过真实 API 与数据库');
    for (const [section, query] of [['members', ''], ['points', ''], ['settings', ''], ['activities', '&tab=venues']]) {
      await navigate(page, `/admin?section=${section}${query}`);
      await shot(page, `admin-${section === 'activities' ? 'venues' : section}-mobile-light-390`, '管理手机布局；本地演示数据库');
    }

    const studentNo = `2099${String(Date.now() % 100000).padStart(5, '0')}`;
    const invitation = await post(context, '/admin/invitations', { maxUses: 1, expiresInDays: 1, batchLabel: '截图注册验收（演示）', allowedStudentNo: studentNo });
    const anonymous = await browser.newContext({ viewport: viewports['390x844'], timezoneId: 'Asia/Shanghai' });
    const registration = await anonymous.newPage();
    observe(registration);
    await navigate(registration, `/register#invite=${invitation.code}`);
    check(!new URL(registration.url()).hash, '邀请 fragment 自动清除，明文不进入产物 URL');
    await shot(registration, 'auth-register-light-390', '本地新建一次性演示邀请；仅用于此次模拟注册');
    await registration.getByRole('button', { name: '验证邀请码', exact: true }).click();
    await registration.getByRole('button', { name: '使用校园 CAS 登录', exact: true }).waitFor();
    await shot(registration, 'auth-register-invitation-verified-light-390', '真实服务端验证邀请；尚未消费名额');
    await registration.getByRole('button', { name: '使用校园 CAS 登录', exact: true }).click();
    await cas(registration, studentNo, '注册验收（演示）');
    await registration.waitForURL(/register\?step=cas_done/);
    await registration.getByLabel('入学年份（选填）').fill('2026');
    await shot(registration, 'auth-register-cas-verified-light-390', '模拟 CAS 真实验票后持有 HttpOnly 预注册凭证');
    await registration.getByRole('button', { name: '提交入社申请', exact: true }).click();
    await registration.getByText('申请已提交，等待审核', { exact: true }).waitFor();
    await shot(registration, 'auth-register-submitted-light-390', '真实注册事务成功；applicant，非自动正式社员');
    const session = await (await anonymous.request.get(`${BASE}/api/v1/auth/session`)).json();
    check(session.data.studentNo === studentNo, '注册完成建立正确学生会话');
    const dashboard = await (await anonymous.request.get(`${BASE}/api/v1/me/dashboard`)).json();
    check(dashboard.data.user.membership === 'applicant', '注册结果为 applicant');
    await anonymous.clearCookies();
    for (const theme of ['light', 'dark']) {
      for (const size of ['1440x900', '390x844']) {
        await registration.setViewportSize(viewports[size]);
        await navigate(registration, '/login', theme);
        await shot(registration, `auth-login-${theme}-${size}`, '匿名登录页；仅校园 CAS 入口');
      }
    }
    for (const [pathname, label] of [['/app', 'member'], ['/admin', 'admin']]) {
      for (const [theme, size] of [['light', '1440x900'], ['dark', '390x844']]) {
        await registration.setViewportSize(viewports[size]);
        await navigate(registration, pathname, theme);
        check(await registration.locator('[data-slot="workspace-sidebar"]').count() === 0, `${label} 未登录时不渲染业务侧栏`);
        await shot(registration, `anonymous-${label}-${theme}-${size}`, '未登录品牌入口；无业务导航/私人面板');
      }
    }
    check(manifest.errors.length === 0, '全部页面无未捕获 JavaScript 异常');
    saveManifest();
    console.log(`完成：${manifest.screenshots.length} 张截图，${manifest.checks.length} 项检查；${OUT}`);
  } finally {
    await browser.close();
  }
}
await main().catch((error) => {
  manifest.failure = error.message;
  saveManifest();
  console.error('截图验收失败:', error.message);
  process.exitCode = 1;
});
