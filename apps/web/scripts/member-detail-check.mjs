/** 隔离 fixture 冒烟：成员活动详情页（页面内视图）与积分排行榜的布局/移动端适配。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const activityId = '5719b631-53e9-43eb-8056-3041711d527f';
const instant = Date.now();
const member = { authenticated: true, principalId: 'fx-member', principalKind: 'student', userId: 'user-1', realName: '林同学', roles: ['member'], token: 'fixture-token' };
const activity = {
  id: activityId, type: 'weekly_contest', status: 'published',
  platform: 'nowcoder', platformContestId: '140235',
  contest: { name: '第 18 场小嘬杯', sourceUrl: null, startTime: new Date(instant - 7200_000).toISOString() },
  title: '社团周赛 · 图论与最短路（演示）', announcement: '本期讲解最短路专题，赛前请完成热身题。', joinNotes: '自带笔记本，提前 10 分钟入场。',
  startAt: new Date(instant - 30 * 60_000).toISOString(), endAt: new Date(instant + 90 * 60_000).toISOString(),
  registerStartAt: null, registerDeadline: new Date(instant + 20 * 60_000).toISOString(), cancelDeadline: null, leaveDeadline: null,
  capacity: 40, waitlistCapacity: 5, remoteAllowed: false, remotePolicy: null, requireValidSubmission: false, scoringConfig: null,
  registrations: [{ status: 'enrolled', waitlistSeq: null }],
  participants: [{ required: false }],
  leaveRequests: [], remotePermissions: [],
  checkpoints: [{ checkpoint: 'IN', acceptedAt: new Date(instant - 15 * 60_000).toISOString(), method: 'QR' }],
  lectureRequests: [{ id: 'lr-1', topic: '最短路专题', status: 'approved', createdAt: new Date(instant - 86400_000).toISOString() }],
  materials: [
    { id: 'm-1', title: '最短路幻灯片', kind: 'slides', fileName: 'shortest-path.pdf', sizeBytes: 2_412_000, createdAt: new Date(instant - 3600_000).toISOString(), uploaderUserId: 'user-1', user: { verifiedRealName: '林同学', profile: { displayName: '阿林' } } },
  ],
  policy: { policy: 'QR_ONLY', checkinOpenAt: new Date(instant - 30 * 60_000).toISOString(), checkinCloseAt: new Date(instant + 60 * 60_000).toISOString(), checkoutOpenAt: new Date(instant + 90 * 60_000).toISOString(), checkoutCloseAt: new Date(instant + 120 * 60_000).toISOString(), maxAccuracyMeters: 50 },
  venueBindings: [{ venueVersionId: 'v-1', venueVersion: { building: '教学楼 A', room: '306', venue: { name: '算法训练室' } } }],
  activityPoints: {
    mine: [{ amount: 12, category: 'activity', scoreMonth: '2026-10', note: '周赛到场', recordedAt: new Date(instant - 1800_000).toISOString() }],
    myTotal: 12,
    board: [
      { rank: 1, userId: 'user-2', name: '陈同学', total: 15, count: 1 },
      { rank: 2, userId: 'user-1', name: '阿林', total: 12, count: 1 },
    ],
    totalAwarded: 27,
  },
};
const context = {
  activity: { id: activityId, title: activity.title, type: 'weekly_contest', startAt: activity.startAt, endAt: activity.endAt, requireValidSubmission: false },
  eligibility: { eligible: true, reason: '', registration: { status: 'enrolled', waitlistSeq: null }, required: false, leave: null, remote: null },
  policy: { policy: 'QR_ONLY', checkinOpenAt: activity.policy.checkinOpenAt, checkinCloseAt: activity.policy.checkinCloseAt, checkoutOpenAt: activity.policy.checkoutOpenAt, checkoutCloseAt: activity.policy.checkoutCloseAt, selfCheckout: true, maxAccuracyMeters: 50, windowOpen: { IN: true, OUT: false } },
  venues: [{ venueVersionId: 'v-1', name: '算法训练室', building: '教学楼 A', room: '306', directions: null, operationalStatus: 'active', allowedCapabilities: ['QR'], hasCoordinates: false }],
  checkpoints: activity.checkpoints, serverTime: new Date().toISOString(),
};
const standings = {
  platform: 'nowcoder', contestId: '140235', contestUrl: 'https://ac.nowcoder.com/acm/contest/140235', ended: false, available: true,
  note: '数据来自牛客实时榜单接口；比赛结束后为最终成绩。', fetchedAt: new Date().toISOString(),
  problems: [
    { index: 'A', name: 'A', fullScore: 50, url: 'https://ac.nowcoder.com/acm/contest/140235/A', clubSolved: 6 },
    { index: 'B', name: 'B', fullScore: 100, url: 'https://ac.nowcoder.com/acm/contest/140235/B', clubSolved: 3 },
    { index: 'C', name: 'C', fullScore: 150, url: 'https://ac.nowcoder.com/acm/contest/140235/C', clubSolved: 1 },
  ],
  clubRanking: [
    { clubRank: 1, userId: 'user-2', name: '陈同学', handle: 'club-chen', solvedCount: 3, score: 300, platformRank: 12 },
    { clubRank: 2, userId: 'user-1', name: '阿林', handle: 'club-lin', solvedCount: 2, score: 150, platformRank: 40 },
    { clubRank: 3, userId: 'user-3', name: '王同学', handle: 'club-wang', solvedCount: 1, score: 50, platformRank: 88 },
  ],
  me: { clubRank: 2, userId: 'user-1', name: '阿林', handle: 'club-lin', solvedCount: 2, score: 150, platformRank: 40, cells: [
    { index: 'A', score: 50, solved: true, failedCount: 0 }, { index: 'B', score: 100, solved: true, failedCount: 1 }, { index: 'C', score: 0, solved: false, failedCount: 2 }] },
  totalEntries: 2140,
};
const leaderboard = { kind: 'current', rows: [
  { rank: 1, userId: 'user-2', displayName: '陈同学', membership: 'formal', e: '18.6', isMe: false },
  { rank: 2, userId: 'user-1', displayName: '阿林', membership: 'formal', e: '16.2', isMe: true },
  { rank: 3, userId: 'user-3', displayName: '王同学', membership: 'provisional', e: '12.9', isMe: false },
  { rank: 4, userId: 'user-4', displayName: '李同学', membership: 'observing', e: '9.4', isMe: false },
] };
const dashboard = { user: { displayName: '阿林', studentNo: '202600001', realName: '林同学', membership: 'formal' }, score: { e: '16.2', components: [], currentMonthM: 6 }, rank: { position: 2, total: 4, qualified: true }, attendance: { done: 3, total: 4, note: null }, openActivities: [], todos: [], upcoming: [], platformSync: [] };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
async function checkViewport(width, height, full = false) {
  const page = await browser.newContext({ viewport: { width, height } }).then((ctx) => ctx.newPage());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path === '/api/v1/auth/csrf' || path === '/api/v1/auth/session') data = member;
    else if (path === '/api/v1/me/dashboard') data = dashboard;
    else if (path === '/api/v1/me/leaderboard') data = leaderboard;
    else if (path === '/api/v1/activities') data = { items: [{ id: activityId, type: 'weekly_contest', platform: 'nowcoder', platformContestId: '140235', title: activity.title, startAt: activity.startAt, endAt: activity.endAt, registerDeadline: activity.registerDeadline, cancelDeadline: null, capacity: 40, enrolledCount: 31, requiredCount: 0, waitlistCapacity: 5, venue: { name: '算法训练室', building: '教学楼 A', room: '306' }, attendancePolicy: 'QR_ONLY', remoteAllowed: false, requireValidSubmission: false, myRegistration: { status: 'enrolled', waitlistSeq: null } }], nextCursor: null };
    else if (path === `/api/v1/activities/${activityId}`) data = activity;
    else if (path.endsWith('/attendance-context')) data = context;
    else if (path.endsWith('/standings')) data = standings;
    else { errors.push(`Unexpected API: ${path}`); return route.abort(); }
    await route.fulfill({ json: { data, meta: null } });
  });
  try {
    // 列表卡片：状态 chip / 名额进度条 / 截止倒计时
    await page.goto(`${BASE}/app?section=activities`);
    await page.getByText(activity.title, { exact: true }).first().waitFor();
    await page.getByText('进行中', { exact: true }).first().waitFor();
    assert.ok((await page.getByRole('progressbar', { name: '报名名额' }).count()) >= 1, 'capacity bar rendered');
    assert.ok((await page.getByText(/后截止/, { exact: false }).count()) >= 1, 'deadline countdown shown');
    assert.ok(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `cards no overflow at ${width}`);
    await page.screenshot({ path: `/private/tmp/member-cards-${width}.png`, fullPage: true });
    // 从卡片进入详情
    await page.getByRole('button', { name: /详情与报名/ }).first().click();
    await page.getByRole('heading', { name: activity.title, exact: true }).waitFor();
    // 平台赛跳转卡 + 签到 + 讲题材料 + 榜单区块
    await page.getByRole('link', { name: /前往比赛页面/ }).waitFor();
    await page.getByRole('heading', { name: /现场签到/ }).waitFor();
    await page.getByRole('heading', { name: /讲题材料/ }).waitFor();
    await page.getByRole('heading', { name: /比赛成绩与社团排名/ }).waitFor();
    await page.getByRole('heading', { name: '活动积分', exact: true }).waitFor();
    assert.equal((await page.getByText('+12', { exact: true }).count()) >= 1, true, 'my points entry');
    assert.equal(await page.getByText('本活动共发放 27 分', { exact: false }).count(), 1, 'points summary');
    // 页面内视图：不再是全屏覆盖弹层
    assert.equal(await page.locator('[data-slot="dialog-content"], [data-slot="sheet-content"]').count(), 0, 'detail renders in-page, not an overlay');
    assert.equal(await page.getByText('二维码签到已记录').count(), 1, 'checkin status integrated');
    // 展开榜单（懒加载）
    await page.getByRole('button', { name: '加载比赛成绩' }).click();
    await page.getByText('#2').first().waitFor();
    await page.getByRole('link', { name: /B ✓ 100/ }).waitFor();
    assert.equal(await page.getByText('陈同学', { exact: true }).count() >= 1, true, 'club ranking row');
    // 申请讲题状态（已批准 → 上传表单可见）
    assert.equal(await page.getByText('你已获得本次活动的材料上传权限', { exact: false }).count(), 1, 'lecture grant note');
    await page.setInputFiles('#material-file', { name: 'sol.md', mimeType: 'text/markdown', buffer: Buffer.from('# new') });
    assert.ok(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `no horizontal overflow at ${width}`);
    await page.screenshot({ path: `/private/tmp/member-detail-${width}.png`, fullPage: true });

    if (full) {
      // 排行榜领奖台
      await page.goto(`${BASE}/app?section=ranking`);
      await page.getByText('社团积分排行榜').waitFor();
      await page.getByText('陈同学', { exact: true }).first().waitFor();
      assert.equal(await page.getByText('16.2', { exact: true }).count() >= 1, true, 'my E on podium');
      assert.ok(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'ranking no overflow');
      await page.screenshot({ path: `/private/tmp/member-ranking-${width}.png`, fullPage: true });
      // 旧签到页链接重定向：section=attendance&id → activities&activity
      await page.goto(`${BASE}/app?section=attendance&id=${activityId}`);
      await page.getByRole('heading', { name: activity.title, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('section'), 'activities', 'legacy attendance link redirected');
      assert.equal(new URL(page.url()).searchParams.get('activity'), activityId, 'legacy id mapped to activity');
    }
    console.log(`✓ ${width}×${height}: detail${full ? ' + ranking + redirect' : ''}`);
  } finally {
    await page.close();
  }
}
try {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 640]]) await checkViewport(width, height, width === 1440);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
