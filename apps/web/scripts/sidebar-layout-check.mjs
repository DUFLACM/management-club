/**
 * 平板侧栏布局隔离验收。仅 mock 会话和空活动目录，不进行 CAS 登录，不验证业务权限。
 * 前置：已构建并启动 web preview（默认 http://localhost:5173），系统 Chrome。
 * 从任意目录运行：node apps/web/scripts/sidebar-layout-check.mjs [--base URL]
 * 产物独立写入 docs/ui-preview/sidebar-*，不会覆盖真实业务截图与 manifest。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = path.join(ROOT, 'docs/ui-preview');
const baseIndex = process.argv.indexOf('--base');
const BASE = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://localhost:5173';
if (!BASE) throw new Error('--base 需要 URL');
const VIEWPORT = { width: 768, height: 1024 };
const manifest = {
  generatedAt: new Date().toISOString(),
  browser: '',
  base: BASE,
  dataScope: '隔离 mock 会话和空活动目录，仅验 768px 平板侧栏布局；不是 CAS 登录，不代表真实身份、权限或业务 API 验收。',
  fixture: { authenticated: true, displayName: '侧栏布局夹具', roles: ['member'], activities: [] },
  mockedEndpoints: ['/api/v1/auth/csrf', '/api/v1/auth/session', '/api/v1/activities'],
  viewport: VIEWPORT,
  theme: 'light',
  screenshots: [],
  geometry: null,
  checks: [],
  errors: [],
  passed: false,
};
fs.mkdirSync(OUT, { recursive: true });
const save = () => fs.writeFileSync(path.join(OUT, 'sidebar-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
function check(condition, description, actual) {
  manifest.checks.push({ description, passed: Boolean(condition), ...(actual === undefined ? {} : { actual }) });
  if (!condition) throw new Error(description);
}
async function noOverflow(page, state) {
  const actual = await page.evaluate(() => ({ pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
  check(actual.pageWidth <= actual.viewportWidth, `${state}页面无整体横向溢出`, actual);
}
async function shot(page, file, description) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  manifest.screenshots.push({ file, viewport: '768×1024', theme: 'light', description, path: '/app?section=activities', dataScope: '隔离 mock 会话布局检查；不是 CAS 登录' });
}

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  manifest.browser = `Chrome ${browser.version()}`;
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.addInitScript(() => localStorage.setItem('club-theme', 'light'));
  const page = await context.newPage();
  page.on('pageerror', error => manifest.errors.push(error.message));
  const unexpectedApi = [];
  await page.route('**/api/v1/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    let data;
    if (pathname === '/api/v1/auth/csrf') {
      data = { authenticated: true, userId: 'sidebar-layout-fixture', studentNo: '202600001', roles: ['member'] };
    } else if (pathname === '/api/v1/auth/session') {
      data = { principalId: 'sidebar-layout-fixture', principalKind: 'member', userId: 'sidebar-layout-fixture', realName: manifest.fixture.displayName, roles: ['member'] };
    } else if (pathname === '/api/v1/activities') {
      data = { items: [], nextCursor: null };
    } else {
      unexpectedApi.push(pathname);
      return route.abort();
    }
    return route.fulfill({ json: { data, meta: null } });
  });
  await page.goto(`${BASE}/app?section=activities`, { waitUntil: 'networkidle' });
  const expand = page.getByRole('button', { name: '展开侧栏', exact: true });
  await expand.waitFor();
  const sidebar = page.locator('[data-slot=workspace-sidebar]');
  const content = page.locator('[data-slot=workspace-content]');
  const collapsedSidebar = await sidebar.boundingBox();
  const before = await content.boundingBox();
  check(collapsedSidebar?.width === 72, '768px 收起侧栏保持 72px 轨道', collapsedSidebar);
  check(before?.x === 72 && before?.width === 696, '业务内容基准位置 x=72、宽度 696px', before);
  check(await expand.getAttribute('aria-expanded') === 'false', '收起状态 aria-expanded=false');
  await noOverflow(page, '收起状态');
  await shot(page, 'sidebar-rail-fixture-768.png', '收起的 72px 平板图标侧栏；会话与空活动目录均为隔离夹具。');

  await expand.click();
  const after = await content.boundingBox();
  const expandedSidebar = await sidebar.boundingBox();
  const backdrop = page.getByRole('button', { name: '关闭展开的侧栏', exact: true });
  const backdropBox = await backdrop.boundingBox();
  manifest.geometry = { before, after, collapsedSidebar, expandedSidebar, backdrop: backdropBox };
  check(expandedSidebar?.width === 232 && expandedSidebar?.x === 0, '展开侧栏为左侧 232px 浮层', expandedSidebar);
  check(before?.x === after?.x && before?.width === after?.width, '展开前后内容位置与宽度保持 x=72、w=696', { before, after });
  check(await backdrop.isVisible() && backdropBox?.width === VIEWPORT.width && backdropBox?.height === VIEWPORT.height, '展开时全屏遮罩可见且覆盖视口', backdropBox);
  check(await page.getByRole('button', { name: '收起侧栏', exact: true }).getAttribute('aria-expanded') === 'true', '展开状态 aria-expanded=true');
  check(await sidebar.getByText(manifest.fixture.displayName, { exact: true }).isVisible(), '展开用户区显示隔离夹具身份');
  await noOverflow(page, '展开状态');
  await shot(page, 'sidebar-overlay-fixture-768.png', '展开为 232px 浮层，遮罩覆盖背景，内容不被压窄；隔离 mock 会话，不是 CAS 登录。');

  await page.keyboard.press('Escape');
  await expand.waitFor();
  check(await expand.getAttribute('aria-expanded') === 'false', 'Escape 关闭浮层并恢复 aria-expanded=false');
  await expand.click();
  await backdrop.click({ position: { x: 600, y: 400 } });
  await expand.waitFor();
  check(await expand.getAttribute('aria-expanded') === 'false', '点击外侧遮罩关闭浮层');
  check(unexpectedApi.length === 0, '未调用未声明的业务 API 或实际认证接口', unexpectedApi);
  check(manifest.errors.length === 0, '无未捕获 JavaScript 页面异常', manifest.errors);
  manifest.passed = true;
  console.log(`通过 ${manifest.checks.length} 项隔离布局检查，${manifest.screenshots.length} 张截图。不是 CAS 登录。`);
} catch (cause) {
  manifest.errors.push(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
} finally {
  save();
  await browser?.close();
}
