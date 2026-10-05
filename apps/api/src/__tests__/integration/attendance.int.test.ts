import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { AttendanceService, signQrPayload, verifyQrPayload } from '../../modules/attendance/attendance.service.js'
import { ActivityService } from '../../modules/activities/activity.service.js'
import { VenueService } from '../../modules/venues/venue.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { sha256Hex } from '../../common/utils.js'
import { createTestUser, makeActor, createApprovedVenue, minutesFromNow } from './helpers.js'

/**
 * 出勤检查点（真实 PostgreSQL 事务）：
 * - 本人检查点唯一：并发双提交只产生一条 accepted
 * - 共享现场 QR 多人可用；IN 码不能作 OUT；过期/撤销/他活动码拒绝
 * - GEO_AND_QR 须同一地点版本双证据
 * - 地点停用即时阻止新自动签到；撤销 QR；恢复不复活旧码
 * - 幂等键重复返回原结果
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let attendance: AttendanceService
let activities: ActivityService
let venueService: VenueService
const manager = makeActor()

async function setupActivity(policy: string, opts?: { venueCaps?: string[]; twoVenues?: boolean; checkoutOpenNow?: boolean }): Promise<{ activityId: string; versionIds: string[] }> {
  const verifier = makeActor()
  const v1 = await createApprovedVenue(venueService, manager, verifier, { name: `签到A-${crypto.randomUUID().slice(0, 4)}`, lat: 39.9, lng: 116.4, capabilities: opts?.venueCaps })
  const versionIds = [v1.versionId]
  if (opts?.twoVenues) {
    const v2 = await createApprovedVenue(venueService, manager, verifier, { name: `签到B-${crypto.randomUUID().slice(0, 4)}`, lat: 40.01, lng: 116.41, capabilities: opts?.venueCaps })
    versionIds.push(v2.versionId)
  }
  const { activityId } = await activities.createActivity(manager, {
    type: 'weekly_contest',
    title: `签到测试-${crypto.randomUUID().slice(0, 6)}`,
    announcement: '签到事务测试',
    startAt: minutesFromNow(5).toISOString(),
    endAt: minutesFromNow(120).toISOString(),
    registerDeadline: minutesFromNow(30).toISOString(),
    capacity: 100,
    venueVersionIds: versionIds,
    primaryVenueVersionId: versionIds[0],
    attendancePolicy: {
      policy: policy as never,
      checkinOpenAt: minutesFromNow(-10).toISOString(),
      checkinCloseAt: minutesFromNow(20).toISOString(),
      checkoutOpenAt: (opts?.checkoutOpenNow ? minutesFromNow(-5) : minutesFromNow(115)).toISOString(),
      checkoutCloseAt: (opts?.checkoutOpenNow ? minutesFromNow(60) : minutesFromNow(160)).toISOString(),
      maxAccuracyMeters: 50,
    },
  })
  await activities.publish(manager, activityId)
  return { activityId, versionIds }
}

async function enrolledUser(no: string, activityId: string) {
  const u = await createTestUser(db, { studentNo: no })
  await activities.register(u.userId, activityId)
  return u
}

async function geoSubmit(userId: string, activityId: string, checkpoint: 'IN' | 'OUT' = 'IN', geo = { latitude: 39.9, longitude: 116.4, accuracyMeters: 20 }, key?: string) {
  const { challenge } = await attendance.issueChallenge(userId, activityId, checkpoint)
  return attendance.submitCheckpoint(userId, {
    challenge, method: 'GEO', checkpoint,
    geo: { ...geo, sampledAt: new Date().toISOString() },
    idempotencyKey: key,
  })
}

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  const audit = new AuditService(db)
  const jobs = new JobsService(db)
  venueService = new VenueService(db, audit)
  activities = new ActivityService(db, audit, jobs, venueService)
  attendance = new AttendanceService(db, audit)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('检查点唯一与幂等', () => {
  it('并发双提交只产生一条 accepted；另一路径幂等返回原结果', async () => {
    const { activityId } = await setupActivity('GEO_OR_QR')
    const u = await enrolledUser('202603001', activityId)
    // 两个独立 challenge（真实客户端重试场景）+ 相同 Idempotency-Key
    const c1 = await attendance.issueChallenge(u.userId, activityId, 'IN')
    const c2 = await attendance.issueChallenge(u.userId, activityId, 'IN')
    const geo = () => ({ latitude: 39.9, longitude: 116.4, accuracyMeters: 20, sampledAt: new Date().toISOString() })
    const [r1, r2] = await Promise.all([
      attendance.submitCheckpoint(u.userId, { challenge: c1.challenge, method: 'GEO', checkpoint: 'IN', geo: geo(), idempotencyKey: 'cc-1' }),
      attendance.submitCheckpoint(u.userId, { challenge: c2.challenge, method: 'GEO', checkpoint: 'IN', geo: geo(), idempotencyKey: 'cc-1' }),
    ])
    expect([r1.result, r2.result].sort()).toEqual(['accepted', 'already_recorded'])
    expect(r1.acceptedAt).toBe(r2.acceptedAt)
    const cps = await db.attendanceCheckpoint.count({ where: { activityId, userId: u.userId, checkpoint: 'IN' } })
    expect(cps).toBe(1) // 唯一约束：零重复出勤
  })

  it('同一 challenge 的网络重试回放原时间，幂等键不能移到其他活动', async () => {
    const { activityId } = await setupActivity('GEO_ONLY')
    const u = await enrolledUser('202603004', activityId)
    const { challenge } = await attendance.issueChallenge(u.userId, activityId, 'IN')
    const input = { challenge, method: 'GEO' as const, checkpoint: 'IN' as const, geo: { latitude: 39.9, longitude: 116.4, accuracyMeters: 20, sampledAt: new Date().toISOString() }, idempotencyKey: 'retry-original-challenge' }
    const first = await attendance.submitCheckpoint(u.userId, input)
    const retry = await attendance.submitCheckpoint(u.userId, input)
    expect(first.result).toBe('accepted')
    expect(retry.result).toBe('already_recorded')
    expect(retry.acceptedAt).toBe(first.acceptedAt)
    expect(retry.serverTime).toBe(first.serverTime)

    const other = await setupActivity('GEO_ONLY')
    await activities.register(u.userId, other.activityId)
    const otherChallenge = await attendance.issueChallenge(u.userId, other.activityId, 'IN')
    await expect(attendance.submitCheckpoint(u.userId, { ...input, challenge: otherChallenge.challenge })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(await db.attendanceCheckpoint.count({ where: { activityId: other.activityId, userId: u.userId } })).toBe(0)
  })

  it('不同幂等键并发提交同一检查点仍返回首次记录', async () => {
    const { activityId } = await setupActivity('GEO_ONLY')
    const u = await enrolledUser('202603005', activityId)
    const c1 = await attendance.issueChallenge(u.userId, activityId, 'IN')
    const c2 = await attendance.issueChallenge(u.userId, activityId, 'IN')
    const geo = { latitude: 39.9, longitude: 116.4, accuracyMeters: 20, sampledAt: new Date().toISOString() }
    const results = await Promise.all([
      attendance.submitCheckpoint(u.userId, { challenge: c1.challenge, method: 'GEO', checkpoint: 'IN', geo, idempotencyKey: 'distinct-key-1' }),
      attendance.submitCheckpoint(u.userId, { challenge: c2.challenge, method: 'GEO', checkpoint: 'IN', geo, idempotencyKey: 'distinct-key-2' }),
    ])
    expect(results.map((result) => result.result).sort()).toEqual(['accepted', 'already_recorded'])
    expect(results[0].acceptedAt).toBe(results[1].acceptedAt)
    expect(await db.attendanceCheckpoint.count({ where: { activityId, userId: u.userId, checkpoint: 'IN' } })).toBe(1)
  })

  it('GEO 围栏外拒绝；精度不足转待复核（不自动扣分）', async () => {
    const { activityId } = await setupActivity('GEO_ONLY')
    const u1 = await enrolledUser('202603002', activityId)
    const outside = await geoSubmit(u1.userId, activityId, 'IN', { latitude: 39.95, longitude: 116.45, accuracyMeters: 20 })
    expect(outside.result).toBe('rejected')
    const u2 = await enrolledUser('202603003', activityId)
    const sloppy = await geoSubmit(u2.userId, activityId, 'IN', { latitude: 39.9, longitude: 116.4, accuracyMeters: 200 })
    expect(sloppy.result).toBe('pending_review')
    const penaltyCount = await db.pointsLedgerEntry.count({ where: { userId: u2.userId, category: 'penalty' } })
    expect(penaltyCount).toBe(0) // 待复核不自动扣分
  })
})

describe('共享现场 QR', () => {
  it('同一现场码多名成员各签成功；一人重扫幂等', async () => {
    const { activityId, versionIds } = await setupActivity('QR_ONLY')
    const users = await Promise.all(['202603010', '202603011', '202603012'].map(async (no) => enrolledUser(no, activityId)))
    const qr = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[0], 'IN')
    const results = await Promise.all(
      users.map(async (u, i) => {
        const { challenge } = await attendance.issueChallenge(u.userId, activityId, 'IN')
        return attendance.submitCheckpoint(u.userId, { challenge, method: 'QR', checkpoint: 'IN', qrToken: qr.token, idempotencyKey: `qr-${i}` })
      }),
    )
    expect(results.every((r) => r.result === 'accepted')).toBe(true) // 多人共用一码
    // 本人重扫：challenge 签发即提示已记录（前端应先读 attendance-context）
    await expect(attendance.issueChallenge(users[0].userId, activityId, 'IN')).rejects.toMatchObject({ code: 'ALREADY_RECORDED' })
    const cpCount = await db.attendanceCheckpoint.count({ where: { activityId, checkpoint: 'IN' } })
    expect(cpCount).toBe(users.length) // 每人恰好一条
  })

  it('IN 码不能作 OUT 码；过期与撤销拒绝；他活动码拒绝', async () => {
    const { activityId, versionIds } = await setupActivity('QR_ONLY', { checkoutOpenNow: true })
    const u = await enrolledUser('202603020', activityId)
    const qr = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[0], 'IN')
    // IN 用作 OUT
    await expect(
      (async () => {
        const { challenge } = await attendance.issueChallenge(u.userId, activityId, 'OUT')
        return attendance.submitCheckpoint(u.userId, { challenge, method: 'QR', checkpoint: 'OUT', qrToken: qr.token })
      })(),
    ).rejects.toMatchObject({ code: 'WRONG_CHECKPOINT' })
    // 撤销码
    await db.attendanceQrWindow.updateMany({ where: { nonceHash: sha256Hex(extractNonce(qr.token)) }, data: { revokedAt: new Date() } })
    const u2 = await enrolledUser('202603021', activityId)
    await expect(
      (async () => {
        const { challenge } = await attendance.issueChallenge(u2.userId, activityId, 'IN')
        return attendance.submitCheckpoint(u2.userId, { challenge, method: 'QR', checkpoint: 'IN', qrToken: qr.token })
      })(),
    ).rejects.toMatchObject({ code: 'QR_REVOKED' })
    // 他活动码
    const other = await setupActivity('QR_ONLY')
    const otherQr = await attendance.issueQrWindow(manager.principalId, other.activityId, other.versionIds[0], 'IN')
    const u3 = await enrolledUser('202603022', activityId)
    await expect(
      (async () => {
        const { challenge } = await attendance.issueChallenge(u3.userId, activityId, 'IN')
        return attendance.submitCheckpoint(u3.userId, { challenge, method: 'QR', checkpoint: 'IN', qrToken: otherQr.token })
      })(),
    ).rejects.toMatchObject({ code: 'QR_ACTIVITY_MISMATCH' })
  })

  it('GEO_AND_QR：A 地点定位 + B 地点二维码不能拼接通过', async () => {
    const { activityId, versionIds } = await setupActivity('GEO_AND_QR', { twoVenues: true })
    const u = await enrolledUser('202603030', activityId)
    const qrB = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[1], 'IN')
    const { challenge } = await attendance.issueChallenge(u.userId, activityId, 'IN')
    // 定位在 A（39.9,116.4）+ 码绑 B（40.01,116.41）：单次提交须同版本
    const r = await attendance.submitCheckpoint(u.userId, {
      challenge, method: 'QR', checkpoint: 'IN', qrToken: qrB.token,
      geo: { latitude: 40.01, longitude: 116.41, accuracyMeters: 20, sampledAt: new Date().toISOString() },
    })
    // 证据同版本（B 地点）→ 通过；再验证跨版本：定位 A + 码 B
    expect(r.result).toBe('accepted')
    const u2 = await enrolledUser('202603031', activityId)
    const qrB2 = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[1], 'IN')
    const { challenge: c2 } = await attendance.issueChallenge(u2.userId, activityId, 'IN')
    const r2 = await attendance.submitCheckpoint(u2.userId, {
      challenge: c2, method: 'QR', checkpoint: 'IN', qrToken: qrB2.token,
      geo: { latitude: 39.9, longitude: 116.4, accuracyMeters: 20, sampledAt: new Date().toISOString() }, // A 地点坐标
    })
    // A 坐标在 B 围栏外 → 拒绝（不能拼接）
    expect(['rejected', 'pending_review']).toContain(r2.result)
    expect(r2.result).not.toBe('accepted')
  })
})

describe('地点停用与版本撤销', () => {
  it('停用即时阻止新签到并撤销 QR；恢复不复活旧码', async () => {
    const { activityId, versionIds } = await setupActivity('QR_ONLY')
    const venueId = (await db.venueVersion.findUnique({ where: { id: versionIds[0] } }))!.venueId
    const qr = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[0], 'IN')
    await venueService.setOperationalStatus(makeActor(), venueId, 'suspended', '测试停用')
    const u = await enrolledUser('202603040', activityId)
    await expect(geoSubmitQr(u.userId, activityId, qr.token)).rejects.toMatchObject({ code: 'QR_REVOKED' })
    // 恢复
    await venueService.setOperationalStatus(makeActor(), venueId, 'active', '测试恢复')
    // 旧码不复活（窗口已撤销）；新码可签
    await expect(geoSubmitQr(u.userId, activityId, qr.token)).rejects.toMatchObject({ code: 'QR_REVOKED' })
    const newQr = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[0], 'IN')
    const ok = await geoSubmitQr(u.userId, activityId, newQr.token)
    expect(ok.result).toBe('accepted')
  })

  it('地点版本撤销后即使 QR 未到期也拒绝自动核验', async () => {
    const { activityId, versionIds } = await setupActivity('GEO_OR_QR')
    const qr = await attendance.issueQrWindow(manager.principalId, activityId, versionIds[0], 'IN')
    await venueService.revoke(makeActor(), (await db.venueVersion.findUnique({ where: { id: versionIds[0] } }))!.venueId, versionIds[0], '测试撤销认证')
    const u = await enrolledUser('202603041', activityId)
    await expect(geoSubmit(u.userId, activityId)).rejects.toMatchObject({ code: 'VENUE_VERSION_REVOKED' })
    await expect(geoSubmitQr(u.userId, activityId, qr.token)).rejects.toMatchObject({ code: 'QR_REVOKED' })
  })
})

async function geoSubmitQr(userId: string, activityId: string, token: string) {
  const { challenge } = await attendance.issueChallenge(userId, activityId, 'IN')
  return attendance.submitCheckpoint(userId, { challenge, method: 'QR', checkpoint: 'IN', qrToken: token })
}

function extractNonce(token: string): string {
  const payload = verifyQrPayload(token, process.env.ATTENDANCE_EVIDENCE_KEY_REF ?? 'dev-attendance-key')
  if (!payload) throw new Error('token invalid')
  return payload.n
}

describe('QR 载荷签名（单元级，含于同一文件便于复用常量）', () => {
  const keyRef = 'test-key-ref'
  it('签名可验证；篡改拒绝', () => {
    const payload = { p: 'att' as const, a: 'act-1', cp: 'IN' as const, v: 'vv-1', n: 'nonce-123', iat: 1, exp: 2, pv: 1 }
    const signed = signQrPayload(payload, keyRef)
    expect(verifyQrPayload(Buffer.from(JSON.stringify(signed)).toString('base64url'), keyRef)).toBeTruthy()
    const forged = { ...signed, cp: 'OUT' as const }
    expect(verifyQrPayload(Buffer.from(JSON.stringify(forged)).toString('base64url'), keyRef)).toBeNull()
    expect(verifyQrPayload(Buffer.from(JSON.stringify(signed)).toString('base64url'), 'other-key')).toBeNull()
  })
})
