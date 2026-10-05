/** 登录入口闪屏回归检查。仅使用隔离 API fixture；前置为 web dev/preview 与系统 Chrome。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseIndex = process.argv.indexOf('--base');
const BASE = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://localhost:5173';
const principal = {
  authenticated: true, principalId: 'entry-fixture', principalKind: 'student',
  userId: 'entry-fixture', studentNo: '202600001', roles: ['member'],
};
const dashboard = {
  user: { displayName: '入口测试', realName: '入口测试', studentNo: '202600001', membership: 'member' },
  score: { e: '0', currentMonthM: 0, components: [] },
  rank: { position: null, total: 0, qualified: false },
  attendance: { done: 0, total: 0, note: null },
  openActivities: [], todos: [], upcoming: [], platformSync: [],
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function checkEntry(viewport, outcome) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  const privateRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // 记录整个首屏过程中匿名入口是否曾挂载，包括只出现一瞬间的情况。
  await page.addInitScript(() => {
    window.entryMounts = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (
            node.matches('[data-slot="entry-actions"]') || node.querySelector('[data-slot="entry-actions"]')
          )) window.entryMounts += 1;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let fail = outcome === 'error';
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/auth/csrf') {
      await held;
      if (fail) {
        // 400 不触发自动重试，验证失败提示与用户手动重试。
        return route.fulfill({ status: 400, json: { error: { code: 'SESSION_CHECK_FAILED', message: '会话检查失败' } } });
      }
      return route.fulfill({ json: { data: outcome === 'anonymous' ? { authenticated: false } : principal, meta: null } });
    }
    privateRequests.push(pathname);
    if (pathname === '/api/v1/auth/session') {
      return route.fulfill({ json: { data: { ...principal, realName: '入口测试' }, meta: null } });
    }
    if (pathname === '/api/v1/me/dashboard') {
      return route.fulfill({ json: { data: dashboard, meta: null } });
    }
    throw new Error(`未声明的 API fixture: ${pathname}`);
  });
  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('status').filter({ hasText: '正在确认登录状态' }).waitFor();
    assert.equal(await page.locator('[data-slot="entry-actions"]').count(), 0);
    assert.equal(await page.locator('[data-slot="workspace-content"]').count(), 0);
    assert.equal(await page.evaluate(() => window.entryMounts), 0);
    assert.deepEqual(privateRequests, []);
    release();

    if (outcome === 'anonymous') {
      await page.getByRole('button', { name: '校园 CAS 登录', exact: true }).waitFor();
      assert.equal(await page.locator('[data-slot="workspace-content"]').count(), 0);
      assert.deepEqual(privateRequests, []);
    } else {
      if (outcome === 'error') {
        await page.getByRole('alert').filter({ hasText: '会话检查失败' }).waitFor();
        assert.deepEqual(privateRequests, []);
        fail = false;
        await page.getByRole('button', { name: '重新连接', exact: true }).click();
      }
      await page.locator('[data-slot="workspace-content"]').waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('[data-slot="entry-actions"]').count(), 0);
      if (outcome === 'authenticated') {
        assert.equal(await page.evaluate(() => window.entryMounts), 0, '已登录首屏不应短暂挂载匿名首页');
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('[data-slot="workspace-content"]').waitFor();
        assert.equal(await page.evaluate(() => window.entryMounts), 0, '刷新后不应短暂挂载匿名首页');
      }
    }
    assert.deepEqual(errors, []);
    console.log(`✓ ${viewport.width}px ${outcome}: 等待阶段无欢迎首页或私人请求，最终状态正确`);
  } finally {
    release();
    await context.close();
  }
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const outcome of ['authenticated', 'anonymous', 'error']) await checkEntry(viewport, outcome);
  }
} finally {
  await browser.close();
}
