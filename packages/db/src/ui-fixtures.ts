import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from './client.js';

// 明确标记的本地截图数据。只更新此脚本拥有的演示活动，不改普通 seed 或实际业务数据。
const root = path.resolve(__dirname, '../../..');
config({ path: path.join(root, '.env'), quiet: true });
const url = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV === 'production' || process.env.AUTH_DEV_SIMULATOR !== 'true'
  || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/acm_club') {
  throw new Error('截图 fixture 仅允许本地 acm_club 开发库与已开启的 CAS 模拟器');
}

const db = createPrismaClient(url.toString());
async function main() {
  const user = await db.user.findUniqueOrThrow({ where: { studentNo: '202600001' } });
  const venue = await db.venue.findFirstOrThrow({ where: { name: '教学楼 A-306（演示）' } });
  if (!venue.effectiveVersionId) throw new Error('请先执行 pnpm db:seed');
  const version = await db.venueVersion.findUniqueOrThrow({ where: { id: venue.effectiveVersionId } });
  const rule = await db.ruleVersion.findFirstOrThrow({ where: { status: 'published' }, orderBy: { version: 'desc' } });
  // 两类权限保持业务分离；仅给已有演示账号补系统设置/同步/审计的截图授权。
  if (!await db.roleGrant.findFirst({ where: { principalId: user.principalId, role: 'system_admin', revokedAt: null } })) {
    await db.roleGrant.create({ data: { id: randomUUID(), principalId: user.principalId, role: 'system_admin', grantedBy: user.principalId } });
  }
  const title = '截图验收 · 签到与签退（演示）';
  const previous = await db.activity.findFirst({ where: { title } });
  const activityId = previous?.id ?? randomUUID();
  const now = Date.now();
  const time = (minutes: number) => new Date(now + minutes * 60_000);
  await db.$transaction(async (tx) => {
    if (previous) {
      // 可重复运行，重置的只有本脚本演示活动的两项检查点及其短期挑战/码。
      await tx.attendanceCheckpoint.deleteMany({ where: { activityId } });
      await tx.attendanceChallenge.deleteMany({ where: { activityId } });
      await tx.attendanceQrWindow.deleteMany({ where: { activityId } });
    }
    const data = {
      type: 'lecture', sourceType: 'custom', title,
      announcement: '本地截图验收演示活动。坐标与冻结榜均为明确标记的 fixture，不代表实际场地采样或赛事结果。签到与签退记录由浏览器向真实 API 提交。',
      startAt: time(2), endAt: time(8), registerStartAt: time(-60), registerDeadline: time(1), cancelDeadline: time(1),
      capacity: 10, waitlistCapacity: 2, requireValidSubmission: false,
      status: 'published', publishedAt: time(-60), venueVersionId: version.id, createdBy: user.principalId,
    };
    await tx.activity.upsert({ where: { id: activityId }, create: { id: activityId, ...data }, update: data });
    await tx.activityVenueBinding.upsert({
      where: { activityId_venueVersionId: { activityId, venueVersionId: version.id } },
      create: { activityId, venueVersionId: version.id, fenceSnapshot: { latitude: Number(version.latitude), longitude: Number(version.longitude), radiusMeters: version.radiusMeters, maxAccuracyMeters: version.maxAccuracyMeters } },
      update: {},
    });
    const policy = { policy: 'GEO_OR_QR', checkinOpenAt: time(-13), checkinCloseAt: time(17), checkoutOpenAt: time(-2), checkoutCloseAt: time(28), selfCheckout: true, maxAccuracyMeters: 45, qrRotateSeconds: 25, qrTtlSeconds: 60 };
    await tx.attendancePolicy.upsert({ where: { activityId }, create: { id: randomUUID(), activityId, ...policy }, update: policy });
    await tx.activityRegistration.upsert({
      where: { activityId_userId: { activityId, userId: user.id } },
      create: { id: randomUUID(), activityId, userId: user.id, status: 'enrolled', acceptedAt: new Date() },
      update: { status: 'enrolled', cancelledAt: null },
    });
    const contestKey = 'ui-preview-demo';
    const freeze = await tx.rankingFreeze.findFirst({ where: { contestKey } });
    const freezeId = freeze?.id ?? randomUUID();
    await tx.rankingFreeze.upsert({
      where: { id: freezeId },
      create: { id: freezeId, contestKey, title: '截图验收冻结榜（演示）', freezeAt: time(-60), ruleVersionId: rule.id, status: 'frozen', scopeNote: '本地 UI fixture；非真实赛事冻结' },
      update: {},
    });
    await tx.frozenRankingRow.upsert({
      where: { freezeId_userId: { freezeId, userId: user.id } },
      create: { id: randomUUID(), freezeId, userId: user.id, position: 1, eSnapshot: '95.0', eligible: true },
      update: {},
    });
    const out = path.join(root, 'docs/ui-preview');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'fixture-context.json'), JSON.stringify({ activityId, freezeId, latitude: Number(version.latitude), longitude: Number(version.longitude), dataScope: '本地开发演示 fixture；非实际场地采样、非真实赛事结果' }, null, 2) + '\n');
  });
  console.log('✓ 本地截图演示 fixture 就绪（IN/OUT 窗口开放、冻结榜示例）；docs/ui-preview/fixture-context.json');
}
void main().finally(() => db.$disconnect());
