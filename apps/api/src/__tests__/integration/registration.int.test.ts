import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { AuthService } from '../../modules/auth/auth.service.js'
import { SessionService } from '../../modules/auth/session.service.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { MembersService } from '../../modules/members/members.service.js'
import { monthKey, sha256Hex } from '../../common/utils.js'
import { makeActor } from './helpers.js'
import type { Request, Response } from 'express'

/**
 * 邀请注册与身份约束（真实 PostgreSQL）：
 * - 最后名额并发兑换只有一人成功、失败整体回滚
 * - 校园编号支持 1–64 位 opaque 文本；非允许字符被 CHECK 拒绝，前导零保留且唯一
 * - CAS 登录（非注册 flow）不能绕过邀请
 * - 注册结果为 applicant，不因注册发初始积分
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let auth: AuthService
let sessions: SessionService
let audit: AuditService
let members: MembersService

/** 极简 cookie jar 模拟（捕获 set-cookie 供下一步请求携带） */
function makeJar(): { jar: Record<string, string>; req: () => Request; res: () => Response } {
  const jar: Record<string, string> = {}
  return {
    jar,
    req: () => ({ cookies: { ...jar }, headers: {} }) as never,
    res: () => {
      const captured: Record<string, { value: string; options: unknown }> = {}
      const res = {
        cookie(name: string, value: string, options: unknown) {
          captured[name] = { value, options }
        },
        clearCookie(name: string) {
          delete captured[name]
        },
        get captured() {
          return captured
        },
      }
      return res as never
    },
    // set 的 cookie 自动进 jar
  }
}

/** 拿一对 (csrfToken, jar)，并把服务端设置的 csrf cookie 写入 jar */
async function primeCsrf(s: SessionService): Promise<{ token: string; jar: Record<string, string> }> {
  const jar: Record<string, string> = {}
  const captured: Record<string, string> = {}
  const res = {
    cookie(name: string, value: string) {
      captured[name] = value
    },
    clearCookie() {},
  } as never as Response
  const { token } = await s.issueAnonymousCsrf({ cookies: jar, headers: {} } as never, res)
  Object.assign(jar, captured)
  return { token, jar }
}

/** set-cookie 中的新值并回 jar（flow/reg cookie） */
function absorb(jar: Record<string, string>, res: { captured: Record<string, { value: string }> }): void {
  for (const [k, v] of Object.entries(res.captured)) jar[k] = v.value
}

function captureRes(): Response & { captured: Record<string, { value: string; options: unknown }> } {
  const captured: Record<string, { value: string; options: unknown }> = {}
  return {
    captured,
    cookie(name: string, value: string, options: unknown) {
      captured[name] = { value, options }
    },
    clearCookie(name: string) {
      delete captured[name]
    },
  } as never
}

async function fullRegisterFlow(studentNo: string, realName: string, invitationSecret: string): Promise<{ ok: boolean; code?: string }> {
  const { token, jar } = await primeCsrf(sessions)
  try {
    // 1. 邀请交换（匿名绑定 cookie + token）
    const r1 = captureRes()
    const exchange = await auth.exchangeInvitation({ cookies: { ...jar }, headers: {} } as never, { secret: invitationSecret }, token)
    absorb(jar, r1)
    // 2. CAS start（写 flow cookie）
    const r2 = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, r2, { purpose: 'register', registrationIntentId: exchange.intentId })
    absorb(jar, r2)
    // 3. 模拟票据 + 回调（dev 模拟器同进程签发）
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, studentNo, realName)
    const flow = new URL(service).searchParams.get('flow')!
    const r3 = captureRes()
    await auth.handleCasCallback({ cookies: { ...jar }, headers: {} } as never, r3, flow, ticket)
    // 4. 预注册 cookie → 最终注册事务
    const regCookie = Object.keys(r3.captured).find((k) => k.endsWith('_reg'))
    if (!regCookie) return { ok: false, code: 'PREREG_MISSING' }
    const r4 = captureRes()
    await auth.completeRegistration({ cookies: { [regCookie]: r3.captured[regCookie].value, ...jar }, headers: {} } as never, r4, { grade: 2026 }, r3.captured[regCookie].value as string, token)
    return { ok: true }
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'ERROR' }
  }
}

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  audit = new AuditService(db)
  sessions = new SessionService(db)
  auth = new AuthService(db, sessions, audit)
  members = new MembersService(db, audit)
  await db.ruleVersion
    .create({
      data: {
        id: crypto.randomUUID(), version: 1, source: 'integration-test',
        params: { monthlyRounding: 'pending', lambdas: [] } as never,
        status: 'published', effectiveFrom: new Date(),
      },
    })
    .catch(() => undefined)
})

afterAll(async () => {
  await db.$disconnect()
})

describe('校园编号约束（数据库层 CHECK/UNIQUE）', () => {
  it('接受可变长数字和字母编号', async () => {
    const p1 = crypto.randomUUID()
    await db.principal.create({ data: { id: p1, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: p1, studentNo: '12345678', verifiedRealName: 'x' } })).resolves.toBeTruthy()
    const p2 = crypto.randomUUID()
    await db.principal.create({ data: { id: p2, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: p2, studentNo: '2026-A.001', verifiedRealName: 'x' } })).resolves.toBeTruthy()
  })

  it('拒绝全角、空格与超长编号；前导零保留且唯一', async () => {
    const p1 = crypto.randomUUID()
    await db.principal.create({ data: { id: p1, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: p1, studentNo: '１２３４５６７８９', verifiedRealName: 'x' } })).rejects.toThrow()
    const pSpace = crypto.randomUUID()
    await db.principal.create({ data: { id: pSpace, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: pSpace, studentNo: 'bad value', verifiedRealName: 'x' } })).rejects.toThrow()
    const pLong = crypto.randomUUID()
    await db.principal.create({ data: { id: pLong, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: pLong, studentNo: 'A'.repeat(65), verifiedRealName: 'x' } })).rejects.toThrow()
    const p2 = crypto.randomUUID()
    await db.principal.create({ data: { id: p2, kind: 'student' } })
    const u = await db.user.create({ data: { id: crypto.randomUUID(), principalId: p2, studentNo: '001234567', verifiedRealName: 'x' } })
    expect(u.studentNo).toBe('001234567')
    const p3 = crypto.randomUUID()
    await db.principal.create({ data: { id: p3, kind: 'student' } })
    await expect(db.user.create({ data: { id: crypto.randomUUID(), principalId: p3, studentNo: '001234567', verifiedRealName: 'y' } })).rejects.toThrow()
  })
})

describe('邀请注册事务', () => {
  it('并发最后名额：maxUses=1 只有一人成功，usedCount=1，状态 exhausted', async () => {
    const secret = 'INVRTESTCONCUR1'
    await db.invitation.create({
      data: {
        id: crypto.randomUUID(), tokenHash: sha256Hex(secret), purpose: 'registration',
        status: 'active', expiresAt: new Date(Date.now() + 3600_000), maxUses: 1, usedCount: 0,
        createdBy: crypto.randomUUID(),
      },
    })
    const [r1, r2] = await Promise.all([
      fullRegisterFlow('202601001', '并发一', secret),
      fullRegisterFlow('202601002', '并发二', secret),
    ])
    expect([r1, r2].filter((r) => r.ok).length).toBe(1)
    const invitation = await db.invitation.findUnique({ where: { tokenHash: sha256Hex(secret) } })
    expect(invitation!.usedCount).toBe(1)
    expect(invitation!.status).toBe('exhausted')
  })

  it('过期邀请被拒绝', async () => {
    const expired = 'INVEXPIREDTEST1'
    await db.invitation.create({
      data: { id: crypto.randomUUID(), tokenHash: sha256Hex(expired), purpose: 'registration', status: 'active', expiresAt: new Date(Date.now() - 1000), maxUses: 1, usedCount: 0, createdBy: crypto.randomUUID() },
    })
    const r = await fullRegisterFlow('202601003', '过期', expired)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVITE_EXPIRED')
  })

  it('CAS 登录 flow 对未注册身份拒绝（不绕过邀请）', async () => {
    const { token, jar } = await primeCsrf(sessions)
    void token
    const r2 = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, r2, { purpose: 'login' })
    absorb(jar, r2)
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, '202601010', '未注册者')
    const flow = new URL(service).searchParams.get('flow')!
    const result: { ok: boolean; code?: string } = await auth
      .handleCasCallback({ cookies: { ...jar }, headers: {} } as never, captureRes(), flow, ticket)
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, code: (e as { code?: string }).code }))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('NOT_REGISTERED')
  })

  it('预登记教职工首次 CAS 登录原子绑定 subject，不消耗邀请', async () => {
    const principalId = crypto.randomUUID()
    const staffId = crypto.randomUUID()
    await db.principal.create({ data: { id: principalId, kind: 'staff' } })
    await db.staffProfile.create({
      data: { id: staffId, principalId, staffNo: 'T-001.A', realName: '张 老师', approvedSource: '集成测试预登记' },
    })
    await db.roleGrant.create({ data: { id: crypto.randomUUID(), principalId, role: 'advisor', grantedBy: principalId } })
    const redemptionsBefore = await db.invitationRedemption.count()

    const { jar } = await primeCsrf(sessions)
    const startRes = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, startRes, { purpose: 'login' })
    absorb(jar, startRes)
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, 'T-001.A', '张　老师')
    const flow = new URL(service).searchParams.get('flow')!
    const callbackRes = captureRes()
    await expect(auth.handleCasCallback({ cookies: { ...jar }, headers: {} } as never, callbackRes, flow, ticket)).resolves.toMatchObject({ redirect: '/app' })

    const sessionCookie = Object.entries(callbackRes.captured).find(([name]) => name === sessions.cookieName())
    expect(sessionCookie).toBeTruthy()
    const actor = await sessions.resolveActor({ cookies: { [sessionCookie![0]]: sessionCookie![1].value }, headers: {} } as never)
    expect(actor).toMatchObject({ principalId, principalKind: 'staff', staffNo: 'T-001.A', campusId: 'T-001.A', realName: '张 老师' })
    expect(actor?.roles).toContain('advisor')
    expect(await db.authIdentity.findUnique({ where: { principalId_provider: { principalId, provider: 'cas' } } })).toMatchObject({
      subject: 'dev-T-001.A', verifiedCampusId: 'T-001.A',
    })
    expect(await db.invitationRedemption.count()).toBe(redemptionsBefore)
  })

  it('已绑定教职工不能用另一 CAS subject 静默重绑', async () => {
    const staff = await db.staffProfile.findUnique({ where: { staffNo: 'T-001.A' } })
    expect(staff).toBeTruthy()
    const { jar } = await primeCsrf(sessions)
    const startRes = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, startRes, { purpose: 'login' })
    absorb(jar, startRes)
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, 'T-001.A', '张 老师')
    ;(auth as unknown as { devTickets: Map<string, { subject: string }> }).devTickets.get(ticket)!.subject = 'different-stable-subject'
    const flow = new URL(service).searchParams.get('flow')!
    await expect(auth.handleCasCallback({ cookies: { ...jar }, headers: {} } as never, captureRes(), flow, ticket)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    expect(await db.authIdentity.count({ where: { principalId: staff!.principalId, provider: 'cas' } })).toBe(1)
  })

  it('Excel 导入成员：校验/去重/冲突跳过，有效行建号', async () => {
    const before = await db.user.count()
    const result = await members.importMembers(makeActor(), [
      { studentNo: '202605001', realName: '导入甲' },
      { studentNo: '202605002', realName: '导入乙', grade: 2026, phone: '13900000000', membershipStatus: 'provisional' },
      { studentNo: 'bad no', realName: '格式不合法' },
      { studentNo: '', realName: '缺学号' },
      { studentNo: '202605003', realName: '' },
      { studentNo: '202605004', realName: '批内重复' },
      { studentNo: '202605004', realName: '批内重复' },
      { studentNo: '202605001', realName: '与已创建行重复' },
    ])
    expect(result.createdCount).toBe(3)
    expect(await db.user.count()).toBe(before + 3)
    const skippedMessages = result.results.filter((r) => r.status === 'skipped').map((r) => r.message)
    expect(skippedMessages).toEqual([
      '学号格式不合法（1-64 位字母/数字/._-）', // 'bad no'（含空格）
      '学号格式不合法（1-64 位字母/数字/._-）', // 空学号
      '姓名为空',
      '本次导入内学号重复', // 202605004 第二次出现
      '本次导入内学号重复', // 202605001 与第一行重复
    ])
  })

  it('Excel 导入遇已存在学号（账号/教职工）跳过', async () => {
    const existingStaffPrincipal = crypto.randomUUID()
    await db.principal.create({ data: { id: existingStaffPrincipal, kind: 'staff' } })
    await db.staffProfile.create({
      data: { id: crypto.randomUUID(), principalId: existingStaffPrincipal, staffNo: 'STAFF-IMPORT-1', realName: '在职教师', approvedSource: '集成测试' },
    })
    const result = await members.importMembers(makeActor(), [
      { studentNo: '202605001', realName: '重复导入（已是账号）' },
      { studentNo: 'STAFF-IMPORT-1', realName: '误把教职工编号当学号' },
    ])
    expect(result.createdCount).toBe(0)
    expect(result.results[0]).toMatchObject({ status: 'skipped', message: '学号已存在（账号）' })
    expect(result.results[1]).toMatchObject({ status: 'skipped', message: '学号已属于教职工主体' })
  })

  it('Excel 导入按录取名次自动记入社基础分（第八条），每人一次，已有账号补记', async () => {
    const actor = makeActor()
    const result = await members.importMembers(actor, [
      { studentNo: '202605101', realName: '名次一', admissionRank: 1 },
      { studentNo: '202605102', realName: '名次三', admissionRank: 3, membershipStatus: 'provisional' },
      { studentNo: '202605103', realName: '无名次' },
      { studentNo: '202605104', realName: '名次越界', admissionRank: 9 },
    ], { admissionTotal: 5, admissionMonth: '2025-10' })
    expect(result).toMatchObject({ createdCount: 3, initialCount: 2, admissionTotal: 5 })
    // m = 5：r=1 → 30；r=3 → 18 + 12 × (1 - 2/4) = 24
    expect(result.results.map((r) => r.initialPoints)).toEqual(['30.00', '24.00', undefined, undefined])
    expect(result.results[3]).toMatchObject({ status: 'skipped', message: '录取名次须为 1–5 的整数' })
    const entries = await db.pointsLedgerEntry.findMany({ where: { category: 'initial', sourceKey: { startsWith: 'initial:' } }, orderBy: { amount: 'desc' } })
    expect(entries.map((e) => [Number(e.amount), e.scoreMonth])).toEqual([[30, '2025-10'], [24, '2025-10']])

    // 再导一次：账号已存在 → 不重复建号也不重复记分；之前没名次的已有账号补记
    const again = await members.importMembers(actor, [
      { studentNo: '202605101', realName: '名次一', admissionRank: 1 },
      { studentNo: '202605103', realName: '无名次', admissionRank: 2 },
    ], { admissionTotal: 5, admissionMonth: '2025-10' })
    expect(again).toMatchObject({ createdCount: 0, initialCount: 1 })
    expect(again.results[0].message).toBe('学号已存在（账号）')
    expect(again.results[1]).toMatchObject({ initialPoints: '27.00', message: '学号已存在（账号），已补记入社基础分 27.00' })

    // 默认 m = max(有名次行数, 最大名次)；仅一人 → 30
    const solo = await members.importMembers(actor, [{ studentNo: '202605105', realName: '独苗', admissionRank: 1 }])
    expect(solo).toMatchObject({ admissionTotal: 1, results: [{ initialPoints: '30.00' }] })
  })

  it('成员概览：入社基础分照常计入 E，但从当月积分里拆出来单独显示', async () => {
    const month = monthKey(new Date())
    const imported = await members.importMembers(makeActor(), [{ studentNo: '202605120', realName: '基础分展示', admissionRank: 1 }], { admissionTotal: 1, admissionMonth: month })
    const user = await db.user.findUniqueOrThrow({ where: { studentNo: '202605120' } })
    expect(imported.initialCount).toBe(1)
    await db.pointsLedgerEntry.create({
      data: { id: crypto.randomUUID(), userId: user.id, sourceKey: `test:activity:${user.id}`, category: 'activity', amount: '2', scoreMonth: month, recordedAt: new Date(), status: 'approved' },
    })
    const dashboard = await members.memberDashboard(user.id)
    expect(dashboard.score.currentMonthM).toBe(2)
    expect(dashboard.score.initial).toEqual({ amount: 30, month, weight: 1, contribution: 30 })
    expect(dashboard.score.components.find((c) => c.month === month)).toMatchObject({ m: 32, initial: 30 })
    expect(Number(dashboard.score.e)).toBe(32)
  })

  it('Excel 预导入学生首次 CAS 登录（login 入口）按学号自动绑定，无需邀请', async () => {
    const imported = await members.importMembers(makeActor(), [{ studentNo: '202605010', realName: '预导入学生' }])
    expect(imported.createdCount).toBe(1)
    const user = await db.user.findUnique({ where: { studentNo: '202605010' } })
    expect(user).toBeTruthy()
    expect(await db.authIdentity.count({ where: { principalId: user!.principalId } })).toBe(0)

    const { jar } = await primeCsrf(sessions)
    const startRes = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, startRes, { purpose: 'login' })
    absorb(jar, startRes)
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, '202605010', '预导入学生')
    const flow = new URL(service).searchParams.get('flow')!
    const callbackRes = captureRes()
    await expect(auth.handleCasCallback({ cookies: { ...jar }, headers: {} } as never, callbackRes, flow, ticket)).resolves.toMatchObject({ redirect: '/app' })

    const sessionCookie = Object.entries(callbackRes.captured).find(([name]) => name === sessions.cookieName())
    expect(sessionCookie).toBeTruthy()
    const actor = await sessions.resolveActor({ cookies: { [sessionCookie![0]]: sessionCookie![1].value }, headers: {} } as never)
    expect(actor).toMatchObject({ principalId: user!.principalId, principalKind: 'student', studentNo: '202605010' })
    expect(await db.authIdentity.findUnique({ where: { principalId_provider: { principalId: user!.principalId, provider: 'cas' } } })).toMatchObject({
      subject: `dev-202605010`, verifiedCampusId: '202605010',
    })
  })

  it('Excel 预导入学生姓名与 CAS 认证不一致：拒绝自动绑定', async () => {
    const imported = await members.importMembers(makeActor(), [{ studentNo: '202605011', realName: '正确姓名' }])
    expect(imported.createdCount).toBe(1)

    const { jar } = await primeCsrf(sessions)
    const startRes = captureRes()
    const redirect = await auth.startCasAuth({ cookies: { ...jar }, headers: {} } as never, startRes, { purpose: 'login' })
    absorb(jar, startRes)
    const service = new URL(redirect).searchParams.get('service')!
    const ticket = auth.devIssueTicket(service, '202605011', '错误姓名')
    const flow = new URL(service).searchParams.get('flow')!
    await expect(
      auth.handleCasCallback({ cookies: { ...jar }, headers: {} } as never, captureRes(), flow, ticket),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    const user = await db.user.findUnique({ where: { studentNo: '202605011' } })
    expect(await db.authIdentity.count({ where: { principalId: user!.principalId } })).toBe(0)
  })

  it('注册成功者为 applicant 且无初始积分', async () => {
    const user = await db.user.findFirst({
      where: { studentNo: { in: ['202601001', '202601002'] } },
      include: { membershipTerms: true, ledgerEntries: true },
    })
    expect(user).toBeTruthy()
    expect(user!.membershipTerms[0]?.membershipStatus).toBe('applicant')
    expect(user!.ledgerEntries).toHaveLength(0)
  })

  it('同一 CAS subject 重复注册被唯一约束拦截（不产生第二账号）', async () => {
    const u = await db.user.findFirst({ where: { studentNo: { in: ['202601001', '202601002'] } } })
    expect(u).toBeTruthy()
    const count = await db.authIdentity.count({ where: { subject: `dev-${u!.studentNo}` } })
    expect(count).toBe(1)
  })
})
