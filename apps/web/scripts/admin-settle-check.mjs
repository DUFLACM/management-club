/** 隔离 fixture 冒烟：管理端活动详情「比赛榜单」tab + 结算按钮 + 指定目录管理（admin ContestsPanel）。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const activityId = '5719b631-53e9-43eb-8056-3041711d527f';
const instant = Date.now();
const admin = { authenticated: true, principalId: 'fx-admin', principalKind: 'staff', userId: null, realName: '管理员', roles: ['presidium'], token: 'fixture-token' };

const activityDetail = {
  id: activityId, revision: 1, type: 'weekly_contest', title: '社团周赛（结算冒烟）', status: 'published',
  sourceType: 'platform', platform: 'nowcoder', platformContestId: '140235',
  announcement: '测试', joinNotes: null,
  startAt: new Date(instant - 7200_000).toISOString(), endAt: new Date(instant - 1800_000).toISOString(),
  registerStartAt: null, registerDeadline: null, cancelDeadline: null,
  capacity: 40, waitlistCapacity: 5, remoteAllowed: false, remotePolicy: null, requireValidSubmission: true,
  scoringConfig: { category: 'contest', lambdaKey: 'B' }, venueVersionId: 'v-1',
  policy: { policy: 'QR_ONLY', checkinOpenAt: new Date(instant - 7200_000).toISOString(), checkinCloseAt: new Date(instant - 1800_000).toISOString(), checkoutOpenAt: null, checkoutCloseAt: null, maxAccuracyMeters: 50, qrRotateSeconds: 25, qrTtlSeconds: 60, selfCheckout: true, autoCheckout: false },
  registrations: [], participants: [],
  venueBindings: [{ venueVersionId: 'v-1', venueVersion: { building: '教学楼 A', room: '306', venue: { name: '算法训练室' } } }],
};
const standings = {
  platform: 'nowcoder', contestId: '140235', contestUrl: 'https://ac.nowcoder.com/acm/contest/140235', ended: true, available: true,
  note: '数据来自牛客实时榜单接口；比赛结束后为最终成绩。', fetchedAt: new Date().toISOString(),
  problems: [{ index: 'A', name: 'A', fullScore: 50, url: null, clubSolved: 6 }],
  clubRanking: [{ clubRank: 1, userId: 'u-1', name: '陈同学', handle: '322487441', displayName: '阿林', solvedCount: 3, score: 300, platformRank: 12 }],
  totalEntries: 2140,
};
const designatedList = [
  { id: 'd-1', category: 'B', groupName: '平台型公开训练赛事', name: 'Codeforces Div.3 / Div.4', platform: 'codeforces', lambdaKey: 'B', note: null, evidenceRef: null },
  { id: 'd-2', category: 'A', groupName: 'ICPC 体系', name: 'ICPC 网络预选赛', platform: null, lambdaKey: null, note: null, evidenceRef: null },
];
const freezes = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((ctx) => ctx.newPage());
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/v1/**', async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  let data;
  if (path === '/api/v1/auth/csrf' || path === '/api/v1/auth/session') data = admin;
  else if (path === '/api/v1/admin/activities') data = { items: [{ id: activityId, title: activityDetail.title, type: 'weekly_contest', status: 'published', sourceType: 'platform', platform: 'nowcoder', startAt: activityDetail.startAt, endAt: activityDetail.endAt, registerDeadline: null, cancelDeadline: null, capacity: 40, waitlistCapacity: 5, remoteAllowed: false, announcement: 'x', policy: { policy: 'QR_ONLY' }, venueVersion: { building: '教学楼 A', room: '306', venue: { name: '算法训练室' } }, _count: { registrations: 31 } }] };
  else if (path === `/api/v1/admin/activities/${activityId}`) data = activityDetail;
  else if (path === `/api/v1/admin/activities/${activityId}/attendance`) data = { items: [], stats: { total: 0, checkedIn: 0, checkedOut: 0, notCheckedIn: 0, leaveApproved: 0, pendingReview: 0 } };
  else if (path === `/api/v1/admin/activities/${activityId}/lecture-requests`) data = [];
  else if (path === `/api/v1/admin/activities/${activityId}/standings`) data = standings;
  else if (path === '/api/v1/admin/freezes') data = freezes;
  else if (path === '/api/v1/admin/platform/designated-contests') data = designatedList;
  else { errors.push(`Unexpected API: ${path}`); return route.abort(); }
  await route.fulfill({ json: { data, meta: null } });
});

try {
  // 1) 活动详情：结算按钮 + 比赛榜单 tab
  await page.goto(`${BASE}/admin?section=activities&activity=${activityId}`);
  await page.getByRole('button', { name: '结算比赛积分' }).waitFor({ timeout: 10_000 });
  await page.getByRole('tab', { name: '比赛榜单' }).click();
  await page.getByRole('button', { name: '加载比赛榜单' }).click();
  await page.getByText('阿林', { exact: true }).waitFor({ timeout: 5000 });
  // displayName 优先于 handle 展示（符合设计：昵称可读性优先）
  assert.ok(await page.locator('main, [data-slot="sheet-content"], body').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 2), 'no horizontal overflow on admin detail');
  await page.screenshot({ path: '/private/tmp/admin-standings-tab.png', fullPage: true });
  console.log('✓ admin detail: settle button + standings tab render');

  // 2) 竞赛与贡献：指定目录管理
  await page.goto(`${BASE}/admin?section=contests`);
  await page.getByRole('heading', { name: '指定比赛认定目录' }).waitFor({ timeout: 10_000 });
  await page.getByText('Codeforces Div.3 / Div.4').waitFor();
  await page.getByText('λ B', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '新增条目' }).click();
  await page.getByLabel('赛事名称').waitFor();
  await page.screenshot({ path: '/private/tmp/admin-designated-catalog.png', fullPage: true });
  console.log('✓ admin contests: designated catalog management renders');

  assert.deepEqual(errors, [], `unexpected console errors: ${errors.join(', ')}`);
} finally {
  await browser.close();
}
