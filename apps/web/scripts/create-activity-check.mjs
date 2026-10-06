/** 隔离 fixture 冒烟：管理端「新建活动」对话框（单一自定义表单，含可选比赛绑定开关）。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const admin = { authenticated: true, principalId: 'fx-admin', principalKind: 'staff', userId: null, realName: '管理员', roles: ['presidium'], token: 'fixture-token' };
const venues = [
  {
    id: 'venue-1', name: '算法训练室', campus: null, building: '教学楼 A', floor: null, room: '306',
    operationalStatus: 'active', suspendReason: null, effectiveVersionId: 'v-1', versionCount: 1,
    versions: [{ id: 'v-1', versionNo: 1, status: 'approved', name: '算法训练室', building: '教学楼 A', room: '306', allowedCapabilities: ['GEO', 'QR'], validFrom: null, validUntil: null, revokedAt: null, approvedAt: new Date().toISOString(), rejectedReason: null, submittedAt: null }],
  },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((ctx) => ctx.newPage());
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/v1/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  let data;
  if (path === '/api/v1/auth/csrf' || path === '/api/v1/auth/session') data = admin;
  else if (path === '/api/v1/admin/activities') data = { items: [] };
  else if (path === '/api/v1/admin/venues') data = venues;
  else { errors.push(`Unexpected API: ${path}`); return route.abort(); }
  await route.fulfill({ json: { data, meta: null } });
});

try {
  await page.goto(`${BASE}/admin?section=activities`);
  await page.getByRole('button', { name: '新建活动', exact: true }).click();
  await page.getByRole('heading', { name: '新建活动', exact: true }).waitFor();

  // 无 tab，单一表单 + 比赛绑定开关
  assert.equal(await page.getByRole('tab').count(), 0, 'no tabs should remain in the create dialog');
  await page.getByText('关联平台比赛（可选）').waitFor();
  assert.equal(await page.getByLabel('比赛 ID *').count(), 0, 'contest id field hidden until bindContest checked');
  await page.getByText('本活动对应一场平台比赛').click();
  await page.getByLabel('比赛 ID *').waitFor({ timeout: 3000 });
  await page.getByRole('combobox', { name: '比赛平台' }).waitFor();
  console.log('✓ 单一表单：比赛绑定开关展开正确');

  // 必填校验仍生效（标题/公告为空时创建按钮禁用）
  const createButton = page.getByRole('button', { name: '创建草稿', exact: true });
  assert.equal(await createButton.isDisabled(), true, 'create button disabled when required fields empty');
  console.log('✓ 必填校验仍生效');

  await page.screenshot({ path: '/private/tmp/create-activity-dialog.png', fullPage: true });

  assert.deepEqual(errors, [], `unexpected console errors: ${errors.join(', ')}`);
  console.log('✓ 全部通过');
} finally {
  await browser.close();
}
