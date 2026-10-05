/** 隔离 API fixture 验证大屏布局与自动更新；不写入真实签到记录。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const baseIndex = process.argv.indexOf('--base');
const BASE = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://localhost:5173';
const activityId = '5719b631-53e9-43eb-8056-3041711d527f';
const venueId = '5c850a07-f805-4a76-8bc3-38934b81d5ef';
const secondVenueId = '20336947-d309-4c09-986b-3e565073cbec';
const instant = Date.now();
const activity = {
  id: activityId, title: '社团周赛 · 图论与最短路（演示）', type: 'weekly_contest',
  status: 'published', sourceType: 'custom', announcement: '现场码大屏验证', revision: 1,
  startAt: new Date(instant - 60_000).toISOString(), endAt: new Date(instant + 3_600_000).toISOString(),
  policy: { policy: 'QR_ONLY', checkinOpenAt: new Date(instant - 60_000).toISOString(), checkinCloseAt: new Date(instant + 3_600_000).toISOString(), checkoutOpenAt: new Date(instant - 60_000).toISOString(), checkoutCloseAt: new Date(instant + 3_900_000).toISOString() },
  registrations: [], participants: [], venueVersionId: venueId,
  venueBindings: [venueId, secondVenueId].map((venueVersionId, i) => ({ venueVersionId, venueVersion: { building: '教学楼 A', room: i ? '307' : '306', venue: { name: '算法训练室' } } })),
};
const principal = { authenticated: true, principalId: 'board-fixture', principalKind: 'staff', userId: null, realName: '现场管理员', roles: ['activity_manager'], token: 'fixture-token' };
const code = await QRCode.toDataURL('club://att#isolated-layout-fixture', { margin: 4, width: 512 });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

async function checkViewport(width, height, fullChecks = false) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  let arrivals = 12;
  let boardRequests = 0;
  let qrRequests = 0;
  let failBoard = false;
  let failBoardStatus = 503;
  let failQr = false;
  let slowIn = false;
  const qrRequestsByCheckpoint = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path === '/api/v1/auth/csrf' || path === '/api/v1/auth/session') data = principal;
    else if (path === '/api/v1/admin/activities') data = [activity];
    else if (path === `/api/v1/admin/activities/${activityId}`) data = activity;
    else if (path.endsWith('/attendance/board')) {
      boardRequests++;
      if (failBoard) return route.fulfill({ status: failBoardStatus, json: { error: { code: 'UNAVAILABLE', message: '名单更新暂时失败' } } });
      data = { checkedIn: arrivals, checkedOut: 3, registeredTotal: 15, pendingTotal: 15 - arrivals, updatedAt: new Date().toISOString(), recentCheckins: Array.from({ length: arrivals }, (_, i) => ({ userId: `member-${i}`, name: i === 0 && arrivals === 13 ? '新签到成员' : ['林同学', '陈同学', '王同学', '李同学'][i % 4] + (Math.floor(i / 4) || ''), acceptedAt: new Date(instant - i * 10_000).toISOString() })), pendingCheckins: [{ userId: 'pending-1', name: '赵同学', studentNo: '202600021' }, { userId: 'pending-2', name: '钱同学', studentNo: '202600022' }] };
    } else if (path.endsWith('/attendance/qr')) {
      qrRequests++;
      const input = route.request().postDataJSON();
      qrRequestsByCheckpoint.push(input.checkpoint);
      if (slowIn && input.checkpoint === 'IN') await new Promise(resolve => setTimeout(resolve, 1000));
      if (failQr) return route.fulfill({ status: 503, json: { error: { code: 'QR_UNAVAILABLE', message: '现场码更新暂时失败' } } });
      data = { dataUrl: `${code}#${input.checkpoint}-${input.venueVersionId}`, expiresAt: new Date(Date.now() + 6000).toISOString(), rotateSeconds: 2 };
    } else {
      errors.push(`Unexpected API: ${path}`);
      return route.abort();
    }
    await route.fulfill({ json: { data, meta: null } });
  });
  try {
    await page.goto(`${BASE}/admin?section=activities&activity=${activityId}`);
    await page.getByRole('button', { name: '现场码大屏', exact: true }).click();
    const board = page.locator('[data-slot="attendance-qr-board"]');
    await board.getByRole('img', { name: '现场活动码' }).waitFor();
    const b = await board.boundingBox();
    assert.ok(Math.abs(b.x) < 1 && Math.abs(b.y) < 1 && b.width === width && b.height === height, `fullscreen viewport ${width}x${height}`);
    assert.ok(await board.evaluate(element => element.scrollWidth <= element.clientWidth), 'board has no horizontal overflow');
    assert.ok(await page.evaluate(() => document.fullscreenElement === document.documentElement), 'opens browser fullscreen');
    assert.equal(await page.getByRole('dialog').count(), 1, 'detail is hidden while board is open');
    await page.screenshot({ path: `/private/tmp/qr-board-${width}.png` });
    if (width >= 1024 && height >= 680) {
      assert.ok(await board.locator('main').evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'desktop main fits in viewport');
    }
    if (fullChecks) {
      const originalClock = await board.locator('time').first().textContent();
      arrivals = 13;
      await board.getByText('新签到成员', { exact: true }).waitFor({ timeout: 6000 });
      assert.match(await board.locator('[data-slot="board-checked-in"]').textContent(), /^13/);
      assert.match(await board.locator('[data-slot="board-registered"]').textContent(), /^15/);
      assert.match(await board.locator('[data-slot="board-pending"]').textContent(), /^2/);
      await board.getByText('赵同学', { exact: true }).waitFor();
      assert.notEqual(await board.locator('time').first().textContent(), originalClock, 'clock ticks');
      assert.ok(qrRequests > 1, 'QR automatically rotates');

      await board.getByRole('button', { name: '签退 OUT', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('img[alt="现场活动码"]')?.src.includes('#OUT-'));
      await board.getByRole('combobox', { name: '签到地点' }).selectOption(secondVenueId);
      await page.waitForFunction(id => document.querySelector('img[alt="现场活动码"]')?.src.endsWith(id), secondVenueId);

      failBoard = true;
      await board.getByText('更新暂停', { exact: true }).waitFor({ timeout: 6000 });
      assert.match(await board.locator('[data-slot="board-checked-in"]').textContent(), /^13/, 'failed refresh keeps last successful total');
      await board.getByText('签到名单加载失败，正在自动重试', { exact: true }).waitFor();
      failBoardStatus = 404;
      await board.getByRole('button', { name: '刷新名单', exact: true }).click();
      await board.getByText('签到名单服务暂不可用，请稍后重试', { exact: true }).waitFor();
      failBoardStatus = 403;
      await board.getByRole('button', { name: '刷新名单', exact: true }).click();
      await board.getByText('当前账号没有查看签到名单的权限', { exact: true }).waitFor();
      failBoard = false;
      await board.getByRole('button', { name: '刷新名单', exact: true }).click();
      await board.getByText('每 3 秒更新', { exact: true }).waitFor();

      failQr = true;
      await board.getByText('现场码更新暂时失败', { exact: true }).waitFor({ timeout: 6000 });
      assert.equal(await board.getByRole('img', { name: '现场活动码' }).count(), 0, 'QR failure hides the old code');
      failQr = false;
      await board.getByRole('img', { name: '现场活动码' }).waitFor({ timeout: 7000 });

      // 断网时移除可扫描码，恢复后自动重新签发和刷新名单。
      await context.setOffline(true);
      await board.getByText('网络已断开，恢复后自动更新', { exact: true }).waitFor();
      assert.equal(await board.getByRole('img', { name: '现场活动码' }).count(), 0);
      await context.setOffline(false);
      await board.getByRole('img', { name: '现场活动码' }).waitFor();
      await board.getByText('每 3 秒更新', { exact: true }).waitFor();

      slowIn = true;
      await board.getByRole('button', { name: '签到 IN', exact: true }).click();
      await page.waitForRequest(request => request.url().endsWith('/attendance/qr') && request.postDataJSON().checkpoint === 'IN');
      await board.getByRole('button', { name: '签退 OUT', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('img[alt="现场活动码"]')?.src.includes('#OUT-'));
      await page.waitForTimeout(1200);
      assert.ok((await board.getByRole('img', { name: '现场活动码' }).getAttribute('src')).includes('#OUT-'), 'late IN response cannot replace OUT code');
    }
    await board.getByRole('button', { name: '返回上一级', exact: true }).click();
    await page.getByRole('button', { name: '现场码大屏', exact: true }).waitFor();
    assert.equal(await board.count(), 0);
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.ok(new URL(page.url()).searchParams.get('activity') === activityId, 'returns to same activity');
    if (fullChecks) {
      const previous = boardRequests;
      await page.waitForTimeout(3500);
      assert.equal(boardRequests, previous, 'polling stops when board closes');
    }
    console.log(`✓ ${width}×${height}: fullscreen, layout, return${fullChecks ? ', clock, polling, QR rotation, switching, recovery, cleanup' : ''}`);
  } finally {
    await context.close();
  }
}
try {
  for (const [width, height] of [[1440, 900], [1920, 1080], [1024, 768], [768, 1024], [390, 844], [320, 640]]) await checkViewport(width, height, width === 1440);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
