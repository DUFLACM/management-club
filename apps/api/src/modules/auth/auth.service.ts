import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { SessionService } from './session.service.js'
import { buildCasLoginUrl, validateCasTicket, CasValidationError } from './cas.client.js'
import { loadEnv, isDevSimulatorEnabled } from '../../config/env.js'
import { generateInviteCode, isValidInviteCodeFormat, newId, randomToken, sha256Hex } from '../../common/utils.js'
import { z } from 'zod'

/**
 * CAS 认证流（03 方案 3）：每次尝试独立 flow + 浏览器绑定 cookie + 数据库状态 + 精确 service。
 * - 防 CSRF：flow 只能被数据库中记录的精确 service 验证；回调核对浏览器绑定。
 * - 防重放/并发回调：原子领取 pending → validating；ST 一次有效。
 * - 防_HOST 伪造：exactService 由服务端从 PUBLIC_BASE_URL 构造，不信任请求头 Host。
 */

export class AuthFlowError extends DomainError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message, code)
  }
}

const FLOW_TTL_MS = 5 * 60_000

export interface StartAuthOptions {
  purpose: 'login' | 'register' | 'reauth' | 'attendance_intent'
  returnTarget?: string
  registrationIntentId?: string
  attendanceIntentId?: string
  renew?: boolean
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private callbackUrl(flow: string): string {
    const env = loadEnv()
    const base = new URL(env.PUBLIC_BASE_URL)
    return `${base.origin}/api/v1/auth/cas/callback?flow=${encodeURIComponent(flow)}`
  }

  /** 发起 CAS：生成 flow、写数据库、设置浏览器绑定 cookie、返回 303 目标 */
  async startCasAuth(req: Request, res: Response, opts: StartAuthOptions): Promise<string> {
    const env = loadEnv()
    const flow = randomToken(24)
    const bindingCookie = randomToken(20)

    let returnTarget = opts.returnTarget
    if (returnTarget) {
      // 只允许同域返回路径，不允许任意外站回跳
      try {
        const u = new URL(returnTarget, env.PUBLIC_BASE_URL)
        if (u.origin !== new URL(env.PUBLIC_BASE_URL).origin) returnTarget = '/app'
        else returnTarget = u.pathname + u.search + u.hash
      } catch {
        returnTarget = '/app'
      }
    }

    await this.db.authAttempt.create({
      data: {
        id: newId(),
        flowHash: sha256Hex(flow),
        purpose: opts.purpose,
        cookieBindingHash: sha256Hex(bindingCookie + flow),
        exactService: this.callbackUrl(flow),
        returnTarget,
        registrationIntentId: opts.registrationIntentId,
        attendanceIntentId: opts.attendanceIntentId,
        expiresAt: new Date(Date.now() + FLOW_TTL_MS),
      },
    })
    res.cookie(`${env.COOKIE_NAME}_flow`, bindingCookie, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api/v1/auth',
      expires: new Date(Date.now() + FLOW_TTL_MS + 60_000),
    })
    if (this.sessions && opts.registrationIntentId == null && opts.attendanceIntentId == null) void this.sessions
    const service = this.callbackUrl(flow)
    // dev 模拟模式：跳本地模拟登录页（页面与日志均标记模拟；生产禁用）
    if (isDevSimulatorEnabled(env)) {
      return `${new URL(env.PUBLIC_BASE_URL).origin}/api/v1/dev-cas/login?service=${encodeURIComponent(service)}`
    }
    return buildCasLoginUrl(service, opts.renew === true)
  }

  /** CAS 回调：原子领取 flow → 核对 cookie → 验票 → 建会话/注册意图推进 */
  async handleCasCallback(req: Request, res: Response, flow: string, ticket: string): Promise<{ redirect: string }> {
    const env = loadEnv()
    // 1. 原子领取（防并发回调/重放：只有一次能从 pending → validating）
    const claimed = await this.db.$queryRaw<Array<{ id: string; purpose: string; cookie_binding_hash: string; exact_service: string; return_target: string | null; registration_intent_id: string | null; attendance_intent_id: string | null }>>`
      UPDATE auth_attempts SET status = 'validating'
      WHERE flow_hash = ${sha256Hex(flow)} AND status = 'pending' AND expires_at > now()
      RETURNING id, purpose, cookie_binding_hash, exact_service, return_target, registration_intent_id, attendance_intent_id`
    if (claimed.length === 0) {
      throw new AuthFlowError('登录流程无效或已使用，请重新发起登录', 'FLOW_INVALID')
    }
    const attempt = claimed[0]

    // 2. 浏览器绑定核对
    const bindingCookie = req.cookies?.[`${env.COOKIE_NAME}_flow`]
    if (typeof bindingCookie !== 'string' || sha256Hex(bindingCookie + flow) !== attempt.cookie_binding_hash) {
      await this.failAttempt(attempt.id, 'COOKIE_BINDING_MISMATCH')
      throw new AuthFlowError('浏览器绑定不匹配，请重新发起登录', 'COOKIE_BINDING_MISMATCH')
    }
    res.clearCookie(`${env.COOKIE_NAME}_flow`, { path: '/api/v1/auth' })

    // 3. 验票（使用数据库保存的完整精确 service）
    try {
      const identity = isDevSimulatorEnabled(env)
        ? await this.devValidateTicket(ticket, attempt.exact_service)
        : await validateCasTicket(ticket, attempt.exact_service)

      // 4. 身份绑定检查
      const outcome = await this.resolveIdentity(attempt, identity)
      await this.db.authAttempt.update({ where: { id: attempt.id }, data: { status: 'consumed', consumedAt: new Date() } })
      const target = attempt.return_target || '/app'
      if (outcome.kind === 'session') {
        this.sessions.setSessionCookie(res, outcome.token, outcome.expiresAt)
        return { redirect: cleanRedirect(target) }
      }
      // register：写注册意图并挂 HttpOnly 预注册 cookie
      res.cookie(`${env.COOKIE_NAME}_reg`, outcome.regToken, {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: 'lax',
        path: '/api/v1/auth',
        expires: outcome.expiresAt,
      })
      const next = outcome.needsCompletion ? '/register?step=cas_done' : target
      return { redirect: cleanRedirect(next) }
    } catch (e) {
      const code = e instanceof CasValidationError ? e.code : 'CAS_ERROR'
      await this.failAttempt(attempt.id, code)
      throw e
    }
  }

  private async failAttempt(id: string, reason: string): Promise<void> {
    await this.db.authAttempt.update({ where: { id }, data: { status: 'failed', failureReason: reason } }).catch(() => undefined)
  }

  private async resolveIdentity(
    attempt: { id: string; purpose: string; registration_intent_id: string | null },
    identity: { subject: string; campusId: string | null; realName: string | null },
  ): Promise<
    | { kind: 'session'; token: string; expiresAt: Date }
    | { kind: 'registration'; regToken: string; expiresAt: Date; needsCompletion: boolean }
  > {
    const existing = await this.db.authIdentity.findUnique({
      where: { provider_subject: { provider: 'cas', subject: identity.subject } },
      include: { principal: { include: { users: true, staffProfiles: true } } },
    })

    if (existing) {
      const user = existing.principal.users[0]
      const staff = existing.principal.staffProfiles[0]
      const storedCampusId = user?.studentNo ?? staff?.staffNo ?? null
      if (!user && !staff) throw new AuthFlowError('认证主体缺少关联资料，请联系管理员核验', 'IDENTITY_INCOMPLETE')
      if (existing.principal.kind === 'student' && !user) throw new AuthFlowError('学生主体缺少学生资料', 'IDENTITY_INCOMPLETE')
      if (existing.principal.kind === 'staff' && !staff) throw new AuthFlowError('教职工主体缺少教职工资料', 'IDENTITY_INCOMPLETE')
      // 校园编号变化/冲突：拒绝自动合并，稳定 subject 也不能静默覆盖资料。
      if (identity.campusId && storedCampusId && identity.campusId !== storedCampusId) {
        await this.audit.log({
          action: 'auth.identity_conflict',
          resourceType: existing.principal.kind === 'staff' ? 'staff_profile' : 'user',
          resourceId: staff?.id ?? user!.id,
          summary: `CAS 校园编号变化（subject ${sha256Hex(identity.subject).slice(0, 8)}），拒绝自动合并`,
        })
        throw new AuthFlowError('校园编号与既有身份不一致，需人工核验', 'IDENTITY_CONFLICT')
      }
      if (user && user.accountStatus !== 'active') {
        throw new AuthFlowError('账号已被停用，不能通过重新注册绕过', 'ACCOUNT_DISABLED')
      }
      if (staff && staff.status !== 'active') throw new AuthFlowError('教职工账号已被停用', 'ACCOUNT_DISABLED')
      if (staff && !staff.staffNo && identity.campusId) {
        await this.db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.campusId!}, 0))`
          const studentConflict = await tx.user.findUnique({ where: { studentNo: identity.campusId! } })
          if (studentConflict) {
            throw new AuthFlowError('校园编号已属于学生主体，拒绝补入教职工资料', 'IDENTITY_CONFLICT')
          }
          await tx.staffProfile.update({ where: { id: staff.id }, data: { staffNo: identity.campusId } })
        })
      }
      await this.db.authIdentity.update({
        where: { id: existing.id },
        data: { verifiedCampusId: identity.campusId ?? existing.verifiedCampusId, verifiedRealName: identity.realName ?? existing.verifiedRealName, lastSeenAt: new Date() },
      })
      const session = await this.sessions.createSession(existing.principalId)
      return { kind: 'session', token: session.token, expiresAt: session.expiresAt }
    }

    // 预登记教职工：首次 CAS 登录按验真校园编号精确绑定稳定 subject。
    // 不根据编号长度猜身份，也不让未预登记教师绕过注册流程。
    const staffOwner = identity.campusId
      ? await this.db.staffProfile.findUnique({ where: { staffNo: identity.campusId } })
      : null
    const studentOwner = identity.campusId
      ? await this.db.user.findUnique({ where: { studentNo: identity.campusId } })
      : null
    if (staffOwner && studentOwner) throw new AuthFlowError('校园编号同时命中学生与教职工资料，需人工核验', 'IDENTITY_CONFLICT')
    if (staffOwner) {
      if (attempt.purpose !== 'login') throw new AuthFlowError('教职工预登记身份请从登录入口进入', 'STAFF_LOGIN_REQUIRED')
      if (!identity.realName || normalizeVerifiedName(identity.realName) !== normalizeVerifiedName(staffOwner.realName)) {
        throw new AuthFlowError('校园认证姓名与教职工预登记不一致，需人工核验', 'IDENTITY_CONFLICT')
      }
      if (staffOwner.status !== 'active') throw new AuthFlowError('教职工账号已被停用', 'ACCOUNT_DISABLED')
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.campusId!}, 0))`
        await tx.$queryRaw`SELECT id FROM staff_profiles WHERE id = ${staffOwner.id}::uuid FOR UPDATE`
        const crossKindOwner = await tx.user.findUnique({ where: { studentNo: identity.campusId! } })
        if (crossKindOwner) throw new AuthFlowError('校园编号已属于学生主体，拒绝绑定教职工', 'IDENTITY_CONFLICT')
        const alreadyBound = await tx.authIdentity.findUnique({
          where: { principalId_provider: { principalId: staffOwner.principalId, provider: 'cas' } },
        })
        if (alreadyBound && alreadyBound.subject !== identity.subject) {
          throw new AuthFlowError('该教职工资料已绑定其他 CAS 主体，需人工核验', 'IDENTITY_CONFLICT')
        }
        if (!alreadyBound) {
          await tx.authIdentity.create({
            data: {
              id: newId(), principalId: staffOwner.principalId, provider: 'cas', subject: identity.subject,
              verifiedCampusId: identity.campusId, verifiedRealName: identity.realName,
            },
          })
          await tx.auditLog.create({
            data: {
              id: newId(), actorPrincipalId: staffOwner.principalId, action: 'auth.staff_identity_bound',
              resourceType: 'staff_profile', resourceId: staffOwner.id,
              summary: `首次 CAS 登录绑定教职工稳定主体（subject ${sha256Hex(identity.subject).slice(0, 8)}）`,
            },
          })
        }
      })
      const session = await this.sessions.createSession(staffOwner.principalId)
      return { kind: 'session', token: session.token, expiresAt: session.expiresAt }
    }

    // 预导入学生（Excel 批量导入时跳过 CAS，资料已就位）：首次 CAS 登录按验真校园编号精确绑定稳定 subject。
    // 仅从登录入口拦截；register 入口命中已存在学号时走下方既有冲突分支（人工核验）。
    if (studentOwner && attempt.purpose === 'login') {
      if (!identity.realName || normalizeVerifiedName(identity.realName) !== normalizeVerifiedName(studentOwner.verifiedRealName)) {
        throw new AuthFlowError('校园认证姓名与预导入资料不一致，需人工核验', 'IDENTITY_CONFLICT')
      }
      if (studentOwner.accountStatus !== 'active') throw new AuthFlowError('账号已被停用', 'ACCOUNT_DISABLED')
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity.campusId!}, 0))`
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${studentOwner.id}::uuid FOR UPDATE`
        const crossKindOwner = await tx.staffProfile.findUnique({ where: { staffNo: identity.campusId! } })
        if (crossKindOwner) throw new AuthFlowError('校园编号已属于教职工主体，拒绝绑定学生', 'IDENTITY_CONFLICT')
        const alreadyBound = await tx.authIdentity.findUnique({
          where: { principalId_provider: { principalId: studentOwner.principalId, provider: 'cas' } },
        })
        if (alreadyBound && alreadyBound.subject !== identity.subject) {
          throw new AuthFlowError('该学生资料已绑定其他 CAS 主体，需人工核验', 'IDENTITY_CONFLICT')
        }
        if (!alreadyBound) {
          await tx.authIdentity.create({
            data: {
              id: newId(), principalId: studentOwner.principalId, provider: 'cas', subject: identity.subject,
              verifiedCampusId: identity.campusId, verifiedRealName: identity.realName,
            },
          })
          await tx.auditLog.create({
            data: {
              id: newId(), actorPrincipalId: studentOwner.principalId, action: 'auth.student_identity_bound',
              resourceType: 'user', resourceId: studentOwner.id,
              summary: `首次 CAS 登录绑定预导入学生主体（subject ${sha256Hex(identity.subject).slice(0, 8)}）`,
            },
          })
        }
      })
      const session = await this.sessions.createSession(studentOwner.principalId)
      return { kind: 'session', token: session.token, expiresAt: session.expiresAt }
    }

    // 新学生身份：仅注册流程可建立账号（须邀请），普通登录不可绕过邀请。
    if (attempt.purpose !== 'register' || !attempt.registration_intent_id) {
      throw new AuthFlowError('该校园身份尚未注册协会系统，请通过邀请注册', 'NOT_REGISTERED')
    }
    if (!identity.campusId) {
      throw new AuthFlowError('校园认证未返回有效的校园编号，暂不能完成注册（需与校方联调属性契约）', 'CAMPUS_ID_MISSING')
    }
    if (!identity.realName) {
      throw new AuthFlowError('校园认证未返回姓名属性（契约未联调）', 'REAL_NAME_MISSING')
    }
    // 校园编号已被其他 subject 占用 → 拒绝自动合并
    if (studentOwner) {
      await this.audit.log({
        action: 'auth.student_no_conflict',
        resourceType: 'user',
        resourceId: studentOwner.id,
        summary: '校园编号被另一 CAS 主体使用，拒绝自动合并',
      })
      throw new AuthFlowError('该校园编号已绑定其他账号，需人工核验', 'CAMPUS_ID_CONFLICT')
    }

    const regToken = randomToken(24)
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    await this.db.registrationIntent.update({
      where: { id: attempt.registration_intent_id },
      data: {
        status: 'cas_verified',
        casSubject: identity.subject,
        studentNo: identity.campusId,
        realName: identity.realName,
        expiresAt,
      },
    })
    // 预注册令牌摘要保存在意图上（复用 cookieBindingHash 字段位置不便；存 intent 表附注）——
    // 使用 registration_intents.anonymous_cookie_hash 字段承载预注册令牌摘要
    await this.db.registrationIntent.update({
      where: { id: attempt.registration_intent_id },
      data: { anonymousCookieHash: sha256Hex(regToken) },
    })
    return { kind: 'registration', regToken, expiresAt, needsCompletion: true }
  }

  // ---------------- 注册：邀请交换与最终事务 ----------------

  /** 邀请码/邀请二维码交换注册意图：不扣名额（预览、扫码、CAS 成功都不占名额） */
  async exchangeInvitation(req: Request, input: { code?: string; secret?: string }, csrfToken: string): Promise<{ intentId: string; invitationSummary: { batchLabel: string | null; expiresAt: Date; remainingUses: number; allowedStudentNo: string | null } }> {
    const cookieHash = await this.sessions.consumeAnonymousBinding(req, csrfToken)
    if (!cookieHash) throw new AuthFlowError('CSRF 校验失败，请刷新页面重试', 'CSRF_INVALID')

    const token = input.secret ?? input.code
    if (!token) throw new AuthFlowError('缺少邀请凭证', 'INVITE_MISSING')
    if (!input.secret && !isValidInviteCodeFormat(input.code ?? '')) {
      throw new AuthFlowError('邀请码格式不正确（12 位去混淆字符）', 'INVITE_FORMAT')
    }
    const invitation = await this.db.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } })
    if (!invitation || invitation.purpose !== 'registration') {
      throw new AuthFlowError('邀请码不存在或已失效', 'INVITE_INVALID')
    }
    if (invitation.status === 'revoked') throw new AuthFlowError('邀请码已被停用', 'INVITE_REVOKED')
    if (invitation.expiresAt < new Date()) throw new AuthFlowError('邀请码已过期', 'INVITE_EXPIRED')
    if (invitation.usedCount >= invitation.maxUses) throw new AuthFlowError('邀请码次数已用尽', 'INVITE_EXHAUSTED')

    const intent = await this.db.registrationIntent.create({
      data: {
        id: newId(),
        invitationId: invitation.id,
        anonymousCookieHash: '',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    })
    await this.sessions.touchAnonymousBinding(cookieHash)
    return {
      intentId: intent.id,
      invitationSummary: {
        batchLabel: invitation.batchLabel,
        expiresAt: invitation.expiresAt,
        remainingUses: invitation.maxUses - invitation.usedCount,
        allowedStudentNo: invitation.allowedStudentNo,
      },
    }
  }

  /**
   * 最终注册事务（03 方案 4.2）：单事务内锁邀请与意图，重检全部条件，
   * 创建 principal/user/authIdentity/applicant 身份与兑换记录，增 used_count。
   * 并发最后一个名额只有一笔成功；失败整体回滚。
   */
  async completeRegistration(
    req: Request,
    res: Response,
    input: { grade?: number; phone?: string },
    preregToken: string | undefined,
    csrfToken: string,
  ): Promise<{ ok: true; userId: string }> {
    const env = loadEnv()
    if (!preregToken) throw new AuthFlowError('缺少预注册凭证，请从校园认证步骤继续', 'PREREG_MISSING')
    if (!(await this.sessions.verifyCsrf(req, csrfToken))) {
      throw new AuthFlowError('CSRF 校验失败', 'CSRF_INVALID')
    }

    const intent = await this.db.registrationIntent.findFirst({
      where: { anonymousCookieHash: sha256Hex(preregToken), status: 'cas_verified' },
      include: { invitation: true },
    })
    if (!intent || intent.expiresAt < new Date()) {
      throw new AuthFlowError('预注册会话已过期，请重新开始注册', 'PREREG_EXPIRED')
    }
    const invitation = intent.invitation
    if (!invitation) throw new AuthFlowError('注册意图缺少邀请关联', 'INVITE_MISSING')
    if (intent.consumedAt) {
      // 幂等重复提交：返回原结果
      const existing = await this.db.invitationRedemption.findUnique({
        where: { invitationId_userId: { invitationId: invitation.id, userId: '' } },
      })
      void existing
      throw new AuthFlowError('该注册意图已使用', 'PREREG_CONSUMED')
    }

    const now = new Date()
    const userId = newId()
    const principalId = newId()

    try {
      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${intent.studentNo!}, 0))`
        const staffConflict = await tx.staffProfile.findUnique({ where: { staffNo: intent.studentNo! } })
        if (staffConflict) throw new AuthFlowError('校园编号已属于教职工主体，拒绝创建学生账号', 'IDENTITY_CONFLICT')
        // 条件更新锁邀请行：检查撤销/过期/次数（失败即回滚）
        const locked = await tx.$queryRaw<Array<{ id: string; allowed_student_no: string | null }>>`
          UPDATE invitations SET used_count = used_count
          WHERE id = ${invitation.id}::uuid
            AND status = 'active'
            AND revoked_at IS NULL
            AND expires_at > now()
            AND used_count < max_uses
          RETURNING id, allowed_student_no`
        if (locked.length === 0) throw new AuthFlowError('邀请已失效或名额已用尽', 'INVITE_UNAVAILABLE')
        if (locked[0].allowed_student_no && locked[0].allowed_student_no !== intent.studentNo) {
          throw new AuthFlowError('该邀请码限定其他学号使用', 'INVITE_STUDENT_MISMATCH')
        }

        // 幂等键：意图只消费一次
        const consumed = await tx.registrationIntent.updateMany({
          where: { id: intent.id, status: 'cas_verified', consumedAt: null },
          data: { status: 'consumed', consumedAt: now },
        })
        if (consumed.count === 0) throw new AuthFlowError('注册意图已被消费', 'PREREG_CONSUMED')

        // 学号与 subject 唯一约束兜底并发
        await tx.principal.create({ data: { id: principalId, kind: 'student' } })
        await tx.user.create({
          data: {
            id: userId,
            principalId,
            studentNo: intent.studentNo!,
            verifiedRealName: intent.realName!,
            grade: input.grade ?? null,
            phone: input.phone ?? null,
          },
        })
        await tx.authIdentity.create({
          data: {
            id: newId(),
            principalId,
            provider: 'cas',
            subject: intent.casSubject!,
            verifiedCampusId: intent.studentNo!,
            verifiedRealName: intent.realName,
          },
        })
        await tx.userProfile.create({ data: { userId, displayName: intent.realName ?? null } })
        // 注册账号是 applicant：不自动成为考察/正式社员，不因注册发初始积分
        await tx.membershipTerm.create({
          data: {
            id: newId(),
            userId,
            semesterId: await currentSemesterId(tx),
            membershipStatus: 'applicant',
            basis: '邀请注册（CAS 验证）自动建立申请记录',
          },
        })
        await tx.roleGrant.create({
          data: { id: newId(), principalId, role: 'member', grantedBy: principalId, grantedAt: now },
        })
        await tx.invitationRedemption.create({
          data: { id: newId(), invitationId: invitation.id, userId, redeemedAt: now },
        })
        await tx.invitation.update({
          where: { id: invitation.id },
          data: { usedCount: { increment: 1 }, status: invitation.usedCount + 1 >= invitation.maxUses ? 'exhausted' : 'active' },
        })
        await tx.auditLog.create({
          data: {
            id: newId(),
            action: 'auth.register',
            resourceType: 'user',
            resourceId: userId,
            summary: `邀请注册成功（applicant；邀请批次 ${invitation.batchLabel ?? '个人'}）`,
          },
        })
        await tx.outboxEvent.create({
          data: { id: newId(), aggregateType: 'user', aggregateId: userId, type: 'user.registered', payload: { userId } },
        })
      })
    } catch (e) {
      if (e instanceof AuthFlowError) throw e
      // 唯一约束冲突（学号/subject 已存在）：已有账号 → 登录流程
      const msg = String((e as Error).message ?? '')
      if (msg.includes('student_no') || msg.includes('provider_subject')) {
        throw new AuthFlowError('该校园身份已有账号，请直接登录', 'ALREADY_REGISTERED')
      }
      throw e
    }

    // 建立正式会话并清理预注册 cookie
    const session = await this.sessions.createSession(principalId)
    this.sessions.setSessionCookie(res, session.token, session.expiresAt)
    res.clearCookie(`${env.COOKIE_NAME}_reg`, { path: '/api/v1/auth' })
    void req
    return { ok: true, userId }
  }

  // ---------------- dev-only CAS 模拟器（production 拒绝启用） ----------------

  private devTickets = new Map<string, { service: string; subject: string; attributes: Record<string, string>; expiresAt: Date }>()

  /** 模拟 CAS 登录页签发 ST（显式 dev-only；与真实 CAS 契约一致：ticket 一次有效且绑定 service） */
  devIssueTicket(service: string, campusId: string, realName: string): string {
    const env = loadEnv()
    if (!isDevSimulatorEnabled(env)) throw new AuthFlowError('模拟器未启用', 'SIM_DISABLED')
    const ticket = `ST-dev-${randomToken(16)}`
    this.devTickets.set(ticket, {
      service,
      subject: `dev-${campusId}`,
      attributes: { user_id: `dev-${campusId}`, id_number: campusId, user_name: realName, unit_name: '大连外国语大学（模拟）' },
      expiresAt: new Date(Date.now() + 120_000),
    })
    return ticket
  }

  private async devValidateTicket(ticket: string, service: string): Promise<{ subject: string; campusId: string | null; realName: string | null; rawAttributes: Record<string, unknown> }> {
    const env = loadEnv()
    if (!isDevSimulatorEnabled(env)) throw new CasValidationError('模拟器未启用', 'SIM_DISABLED')
    const t = this.devTickets.get(ticket)
    if (!t) throw new CasValidationError('模拟票据不存在或已使用', 'SIM_TICKET_INVALID')
    this.devTickets.delete(ticket) // ST 一次有效
    if (t.expiresAt < new Date()) throw new CasValidationError('模拟票据已过期', 'SIM_TICKET_EXPIRED')
    if (t.service !== service) throw new CasValidationError('模拟票据 service 不匹配', 'SIM_SERVICE_MISMATCH')
    return {
      subject: t.subject,
      campusId: t.attributes.id_number,
      realName: t.attributes.user_name,
      rawAttributes: t.attributes,
    }
  }
}

type DbClient = import('@acm/db').Prisma.TransactionClient

async function currentSemesterId(tx: DbClient): Promise<string> {
  const now = new Date()
  const semester = await tx.semester.findFirst({ where: { startsOn: { lte: now } }, orderBy: { startsOn: 'desc' } })
  if (semester) return semester.id
  const created = await tx.semester.create({
    data: { id: newId(), code: 'DEFAULT', name: '默认学期（初始化）', startsOn: new Date('2026-01-01'), endsOn: new Date('2027-01-01') },
  })
  return created.id
}

function cleanRedirect(target: string): string {
  return target.startsWith('/') && !target.startsWith('//') ? target : '/app'
}

function normalizeVerifiedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

// 邀请创建（管理端）
export const createInvitationSchema = z.object({
  maxUses: z.number().int().min(1).max(200).default(1),
  expiresInDays: z.number().int().min(1).max(365).default(14),
  batchLabel: z.string().max(64).optional(),
  allowedStudentNo: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
})

export function newInvitationSecret(): string {
  return generateInviteCode()
}
