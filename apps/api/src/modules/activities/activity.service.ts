import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { VenueService } from '../venues/venue.service.js'
import { newId } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'
import { Prisma } from '@acm/db'

/**
 * 活动模块（01/02/03 方案）：
 * - 三种来源：导入平台赛事（202+job 建草稿）、自定义比赛、普通活动。
 * - 发布前固定策略快照（policyVersion/scoringConfig/围栏快照）；发布校验地点认证覆盖窗口与能力。
 * - 报名：最后名额原子分配（活动行锁 + 唯一约束兜底）；候补按公告递补；必到名单独立。
 */

export class ActivityError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const activityInputSchema = z.object({
  type: z.enum(['weekly_contest', 'monthly_contest', 'custom_contest', 'lecture', 'training', 'meeting', 'gathering', 'camp', 'service']),
  title: z.string().min(2).max(120),
  announcement: z.string().min(5).max(20000),
  joinNotes: z.string().max(4000).optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  registerStartAt: z.string().datetime().nullable().optional(),
  registerDeadline: z.string().datetime().nullable().optional(),
  cancelDeadline: z.string().datetime().nullable().optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  waitlistCapacity: z.number().int().min(0).max(500).optional(),
  approvalRequired: z.boolean().optional(),
  waitlistConfirmHours: z.number().int().min(1).max(72).optional(),
  remoteAllowed: z.boolean().optional(),
  remotePolicy: z.string().max(1000).optional(),
  leaveDeadline: z.string().datetime().nullable().optional(),
  requireValidSubmission: z.boolean().optional(),
  scoringConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  contestMeta: z.record(z.string(), z.unknown()).nullable().optional(),
  platform: z.string().max(40).optional(),
  platformContestId: z.string().max(64).optional(),
  /** 允许签到地点版本集合；主显示地点 */
  venueVersionIds: z.array(z.string().uuid()).min(1, '请选择至少一个签到地点').max(10).optional(),
  primaryVenueVersionId: z.string().uuid().nullable().optional(),
  attendancePolicy: z
    .object({
      policy: z.enum(['GEO_ONLY', 'QR_ONLY', 'GEO_OR_QR', 'GEO_AND_QR']),
      checkinOpenAt: z.string().datetime(),
      checkinCloseAt: z.string().datetime(),
      checkoutOpenAt: z.string().datetime().nullable().optional(),
      checkoutCloseAt: z.string().datetime().nullable().optional(),
      maxAccuracyMeters: z.number().min(5).max(200).optional(),
      qrRotateSeconds: z.number().int().min(10).max(120).optional(),
      qrTtlSeconds: z.number().int().min(20).max(300).optional(),
      selfCheckout: z.boolean().optional(),
    })
    .nullable()
    .optional(),
})
export type ActivityInput = z.infer<typeof activityInputSchema>

export const activityUpdateSchema = activityInputSchema
  .omit({ platform: true, platformContestId: true, contestMeta: true })
  .partial()
  .extend({
    expectedRevision: z.number().int().min(1),
    joinNotes: z.string().max(4000).nullable().optional(),
    remotePolicy: z.string().max(1000).nullable().optional(),
  })
  .strict()
export type ActivityUpdate = z.infer<typeof activityUpdateSchema>

const CONTEST_TYPES = new Set(['weekly_contest', 'monthly_contest', 'custom_contest'])

@Injectable()
export class ActivityService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly venueService: VenueService,
  ) {}

  /** 创建活动草稿（自定义比赛/普通活动） */
  async createActivity(actor: SessionActor, input: ActivityInput): Promise<{ activityId: string }> {
    if (new Date(input.startAt) >= new Date(input.endAt)) throw new ActivityError('活动起止时间不正确', 'TIME_ORDER')
    if (!input.venueVersionIds?.length) throw new ActivityError('请选择签到地点后再创建活动', 'NO_VENUE')
    if (input.primaryVenueVersionId && !input.venueVersionIds.includes(input.primaryVenueVersionId)) throw new ActivityError('主显示地点必须属于绑定地点集合', 'VENUE_MISMATCH')
    const activityId = newId()
    await this.db.$transaction(async (tx) => {
      await tx.activity.create({
        data: {
          id: activityId,
          type: input.type,
          sourceType: input.platform ? 'platform' : 'custom',
          platform: input.platform ?? undefined,
          platformContestId: input.platformContestId ?? undefined,
          title: input.title,
          announcement: input.announcement,
          joinNotes: input.joinNotes,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          registerStartAt: input.registerStartAt ? new Date(input.registerStartAt) : null,
          registerDeadline: input.registerDeadline ? new Date(input.registerDeadline) : null,
          cancelDeadline: input.cancelDeadline ? new Date(input.cancelDeadline) : null,
          capacity: input.capacity ?? null,
          waitlistCapacity: input.waitlistCapacity ?? 0,
          approvalRequired: input.approvalRequired ?? false,
          waitlistConfirmHours: input.waitlistConfirmHours ?? null,
          remoteAllowed: input.remoteAllowed ?? false,
          remotePolicy: input.remotePolicy,
          leaveDeadline: input.leaveDeadline ? new Date(input.leaveDeadline) : null,
          requireValidSubmission: input.requireValidSubmission ?? CONTEST_TYPES.has(input.type),
          scoringConfig: (input.scoringConfig ?? undefined) as never,
          contestMeta: (input.contestMeta ?? undefined) as never,
          venueVersionId: input.primaryVenueVersionId ?? input.venueVersionIds![0],
          createdBy: actor.principalId,
        },
      })
      if (input.attendancePolicy) {
        await tx.attendancePolicy.create({
          data: {
            id: newId(),
            activityId,
            policy: input.attendancePolicy.policy,
            checkinOpenAt: new Date(input.attendancePolicy.checkinOpenAt),
            checkinCloseAt: new Date(input.attendancePolicy.checkinCloseAt),
            checkoutOpenAt: input.attendancePolicy.checkoutOpenAt ? new Date(input.attendancePolicy.checkoutOpenAt) : null,
            checkoutCloseAt: input.attendancePolicy.checkoutCloseAt ? new Date(input.attendancePolicy.checkoutCloseAt) : null,
            maxAccuracyMeters: input.attendancePolicy.maxAccuracyMeters ?? 50,
            qrRotateSeconds: input.attendancePolicy.qrRotateSeconds ?? 25,
            qrTtlSeconds: input.attendancePolicy.qrTtlSeconds ?? 60,
            selfCheckout: input.attendancePolicy.selfCheckout ?? true,
          },
        })
      }
      if (input.venueVersionIds?.length) {
        for (const vid of input.venueVersionIds) {
          await tx.activityVenueBinding.create({ data: { activityId, venueVersionId: vid } })
        }
      }
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.create',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `创建活动草稿 ${input.title}`,
    })
    return { activityId }
  }

  /** 草稿可编辑；行锁与 revision 防止覆盖别人修改或与发布交叉。 */
  async updateDraft(actor: SessionActor, activityId: string, input: ActivityUpdate) {
    const { expectedRevision, attendancePolicy, venueVersionIds, primaryVenueVersionId, scoringConfig, ...fields } = input
    const result = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      const current = await tx.activity.findUnique({ where: { id: activityId }, include: { policy: true, venueBindings: true } })
      if (!current) throw new ActivityError('活动不存在', 'NOT_FOUND')
      if (current.status !== 'draft') throw new ActivityError('仅草稿可编辑；活动发布后配置已固化', 'NOT_DRAFT')
      if (current.revision !== expectedRevision) throw new ActivityError('草稿已被其他人修改，请关闭编辑并刷新详情后重试', 'REVISION_CONFLICT')
      const start = fields.startAt ? new Date(fields.startAt) : current.startAt
      const end = fields.endAt ? new Date(fields.endAt) : current.endAt
      if (start >= end) throw new ActivityError('活动起止时间不正确', 'TIME_ORDER')
      const registrationStart = fields.registerStartAt === undefined ? current.registerStartAt : fields.registerStartAt ? new Date(fields.registerStartAt) : null
      const registrationEnd = fields.registerDeadline === undefined ? current.registerDeadline : fields.registerDeadline ? new Date(fields.registerDeadline) : null
      if (registrationStart && registrationEnd && registrationStart >= registrationEnd) throw new ActivityError('报名开始须早于报名截止', 'TIME_ORDER')
      if (attendancePolicy) {
        if (new Date(attendancePolicy.checkinOpenAt) >= new Date(attendancePolicy.checkinCloseAt)) throw new ActivityError('签到窗口起须早于窗口止', 'TIME_ORDER')
        if (Boolean(attendancePolicy.checkoutOpenAt) !== Boolean(attendancePolicy.checkoutCloseAt)) throw new ActivityError('签退窗口起止须同时填写或同时留空', 'TIME_ORDER')
        if (attendancePolicy.checkoutOpenAt && attendancePolicy.checkoutCloseAt && new Date(attendancePolicy.checkoutOpenAt) >= new Date(attendancePolicy.checkoutCloseAt)) throw new ActivityError('签退窗口起须早于窗口止', 'TIME_ORDER')
      }
      const bindings = [...new Set(venueVersionIds ?? current.venueBindings.map((binding) => binding.venueVersionId))]
      if (!bindings.length) throw new ActivityError('请选择签到地点后再保存草稿', 'NO_VENUE')
      const primary = primaryVenueVersionId === undefined ? current.venueVersionId : primaryVenueVersionId
      if (primary && !bindings.includes(primary)) throw new ActivityError('主显示地点必须属于绑定地点集合', 'VENUE_MISMATCH')
      const saved = await tx.activity.update({
        where: { id: activityId },
        data: {
          ...fields,
          startAt: start,
          endAt: end,
          registerStartAt: registrationStart,
          registerDeadline: registrationEnd,
          cancelDeadline: fields.cancelDeadline === undefined ? undefined : fields.cancelDeadline ? new Date(fields.cancelDeadline) : null,
          leaveDeadline: fields.leaveDeadline === undefined ? undefined : fields.leaveDeadline ? new Date(fields.leaveDeadline) : null,
          ...(scoringConfig !== undefined ? { scoringConfig: scoringConfig === null ? Prisma.DbNull : scoringConfig as Prisma.InputJsonObject } : {}),
          venueVersionId: primary,
          revision: { increment: 1 },
          ...(attendancePolicy !== undefined ? { policyVersion: { increment: 1 } } : {}),
        },
      })
      if (attendancePolicy === null) await tx.attendancePolicy.deleteMany({ where: { activityId } })
      else if (attendancePolicy) {
        const policy = {
          ...attendancePolicy,
          checkinOpenAt: new Date(attendancePolicy.checkinOpenAt),
          checkinCloseAt: new Date(attendancePolicy.checkinCloseAt),
          checkoutOpenAt: attendancePolicy.checkoutOpenAt ? new Date(attendancePolicy.checkoutOpenAt) : null,
          checkoutCloseAt: attendancePolicy.checkoutCloseAt ? new Date(attendancePolicy.checkoutCloseAt) : null,
        }
        await tx.attendancePolicy.upsert({
          where: { activityId },
          create: { id: newId(), activityId, ...policy },
          update: { ...policy, revision: { increment: 1 }, version: { increment: 1 } },
        })
      }
      if (venueVersionIds !== undefined) {
        await tx.activityVenueBinding.deleteMany({ where: { activityId } })
        if (bindings.length) await tx.activityVenueBinding.createMany({ data: bindings.map((venueVersionId) => ({ activityId, venueVersionId })) })
      }
      return { activityId, revision: saved.revision, title: saved.title }
    })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'activity.update', resourceType: 'activity', resourceId: activityId, summary: `修改活动草稿 ${result.title}`, after: input })
    return { activityId: result.activityId, revision: result.revision }
  }

  /** 导入平台赛事：只建未发布草稿 + 后台 job 拉取元数据（202） */
  async importContest(
    actor: SessionActor,
    input: { platform: 'nowcoder' | 'codeforces' | 'atcoder' | 'hydro'; contestId?: string; officialUrl?: string; hydroInstanceId?: string; hydroDomainId?: string },
  ): Promise<{ draftActivityId: string; jobId: string }> {
    let contestId = input.contestId
    if (!contestId && input.officialUrl) {
      const extracted = this.extractContestId(input.platform, input.officialUrl)
      if (extracted) contestId = extracted
    }
    if (!contestId) throw new ActivityError('缺少比赛 ID 或无法从链接提取', 'CONTEST_ID_MISSING')
    const draftActivityId = newId()
    await this.db.activity.create({
      data: {
        id: draftActivityId,
        type: 'custom_contest',
        sourceType: input.platform === 'hydro' ? 'hydro' : 'platform',
        platform: input.platform,
        platformContestId: contestId,
        title: `导入中：${input.platform} ${contestId}`,
        announcement: '（元数据待后台获取，完成后编辑公告与规则）',
        startAt: new Date(Date.now() + 7 * 24 * 3600_000),
        endAt: new Date(Date.now() + 7 * 24 * 3600_000 + 2 * 3600_000),
        createdBy: actor.principalId,
      },
    })
    const enqueued = await this.jobs.enqueue({
      type: 'activity.import_contest',
      payload: { activityId: draftActivityId, platform: input.platform, contestId, hydroInstanceId: input.hydroInstanceId, hydroDomainId: input.hydroDomainId },
      dedupeKey: `import:${input.platform}:${contestId}`,
      priority: 4,
    })
    const jobId = enqueued.id
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.import',
      resourceType: 'activity',
      resourceId: draftActivityId,
      summary: `导入 ${input.platform} 比赛 ${contestId}`,
    })
    return { draftActivityId, jobId }
  }

  /** 从官方链接提取比赛 ID（服务端重建请求地址；不抓取任意 URL） */
  private extractContestId(platform: string, url: string): string | null {
    try {
      const u = new URL(url)
      const hostOk =
        platform === 'nowcoder' ? u.hostname === 'ac.nowcoder.com'
        : platform === 'codeforces' ? u.hostname === 'codeforces.com'
        : platform === 'atcoder' ? u.hostname === 'atcoder.jp'
        : true
      if (!hostOk) throw new ActivityError('链接主机不符', 'HOST_MISMATCH')
      const m = u.pathname.match(/(\d{4,})/)
      return m ? m[1] : null
    } catch {
      throw new ActivityError('无法解析比赛链接', 'URL_INVALID')
    }
  }

  /** 发布：校验地点绑定全部 approved/active/有效期覆盖 IN/OUT 窗口 + 策略能力匹配，固化围栏快照 */
  async publish(actor: SessionActor, activityId: string): Promise<void> {
    const title = await this.db.$transaction(async (tx) => {
      // 与草稿保存共用行锁，校验和快照始终来自同一版配置。
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      const activity = await tx.activity.findUnique({
        where: { id: activityId },
        include: { policy: true, venueBindings: { include: { venueVersion: true } } },
      })
      if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
      if (activity.status !== 'draft') throw new ActivityError('活动不是草稿状态', 'STATE_INVALID')
      if (!activity.policy) throw new ActivityError('现场活动必须配置签到策略（普通线上活动除外，请说明）', 'POLICY_MISSING')

      const windowStart = activity.policy.checkinOpenAt
      const windowEnd = activity.policy.checkoutCloseAt ?? activity.policy.checkoutOpenAt ?? activity.policy.checkinCloseAt
      const needed: string[] = activity.policy.policy === 'GEO_ONLY' ? ['GEO']
        : activity.policy.policy === 'QR_ONLY' ? ['QR']
        : activity.policy.policy === 'GEO_AND_QR' ? ['GEO', 'QR']
        : ['GEO', 'QR'] // GEO_OR_QR 需两种能力都已核验（用户任选其一）
      if (activity.venueBindings.length === 0) {
        throw new ActivityError('未绑定允许签到地点；纯二维码活动也须绑定地点版本（房间与现场证明）', 'NO_VENUE')
      }
      for (const binding of activity.venueBindings) {
        await this.venueService.assertVersionPublishable(binding.venueVersionId, needed, windowStart, windowEnd)
      }

      await tx.activity.update({
        where: { id: activityId },
        data: { status: 'published', publishedAt: new Date(), revision: { increment: 1 } },
      })
      // 固化围栏快照（后续地点新草稿不移动本活动围栏）
      for (const binding of activity.venueBindings) {
        await tx.activityVenueBinding.update({
          where: { activityId_venueVersionId: { activityId, venueVersionId: binding.venueVersionId } },
          data: {
            fenceSnapshot: {
              latitude: binding.venueVersion.latitude ? Number(binding.venueVersion.latitude) : null,
              longitude: binding.venueVersion.longitude ? Number(binding.venueVersion.longitude) : null,
              radiusMeters: binding.venueVersion.radiusMeters ? Number(binding.venueVersion.radiusMeters) : null,
              maxAccuracyMeters: binding.venueVersion.maxAccuracyMeters ? Number(binding.venueVersion.maxAccuracyMeters) : null,
              room: binding.venueVersion.room,
              building: binding.venueVersion.building,
              allowedCapabilities: binding.venueVersion.allowedCapabilities,
            } as never,
          },
        })
      }
      // 冻结必到名单快照
      await tx.activityParticipant.updateMany({
        where: { activityId, required: true, frozenAt: null },
        data: { frozenAt: new Date() },
      })
      return activity.title
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.publish',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `发布活动 ${title}`,
    })
  }

  /**
   * 报名（02 方案 6.1 / 03 方案 5）：
   * - 活动行锁下检查截止/资格/容量 → 写入 enrolled/waitlisted/pending_approval。
   * - 重复提交幂等返回原状态；不重复占名额。
   * - 扫码不能自动报名：本接口是唯一报名入口。
   */
  async register(userId: string, activityId: string, idempotencyKey?: string): Promise<{ status: string; waitlistSeq: number | null; message: string }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      const activity = await tx.activity.findUnique({ where: { id: activityId } })
      if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
      if (activity.status !== 'published') throw new ActivityError('活动未发布或已结束报名', 'NOT_PUBLISHED')
      const now = new Date()
      if (activity.registerStartAt && activity.registerStartAt > now) throw new ActivityError('报名尚未开始', 'REG_NOT_OPEN')
      if (activity.registerDeadline && activity.registerDeadline < now) throw new ActivityError('报名已截止', 'REG_CLOSED')

      const existing = await tx.activityRegistration.findUnique({
        where: { activityId_userId: { activityId, userId } },
      })
      if (existing && ['enrolled', 'waitlisted', 'pending_approval'].includes(existing.status)) {
        return { status: existing.status, waitlistSeq: existing.waitlistSeq, message: '已提交过报名（幂等返回原结果）' }
      }

      const enrolledCount = await tx.activityRegistration.count({ where: { activityId, status: 'enrolled' } })
      const waitlistedCount = await tx.activityRegistration.count({ where: { activityId, status: 'waitlisted' } })
      let status: string
      let waitlistSeq: number | null = null
      const waitlistCap = activity.waitlistCapacity ?? 0
      if (activity.capacity == null || enrolledCount < activity.capacity) {
        status = activity.approvalRequired ? 'pending_approval' : 'enrolled'
      } else if (waitlistCap > 0 && waitlistedCount < waitlistCap) {
        status = 'waitlisted'
        waitlistSeq = waitlistedCount + 1
      } else {
        throw new ActivityError('名额已满且候补已满', 'CAPACITY_FULL')
      }

      if (existing) {
        await tx.activityRegistration.update({
          where: { id: existing.id },
          data: { status, waitlistSeq, acceptedAt: status === 'enrolled' ? now : null, cancelledAt: null, revision: { increment: 1 } },
        })
      } else {
        await tx.activityRegistration.create({
          data: {
            id: newId(),
            activityId,
            userId,
            status,
            waitlistSeq,
            acceptedAt: status === 'enrolled' ? now : null,
            idempotencyKey: idempotencyKey ?? null,
          },
        })
      }
      await tx.registrationHistory.create({
        data: { id: newId(), registrationId: (await tx.activityRegistration.findUnique({ where: { activityId_userId: { activityId, userId } } }))!.id, toStatus: status, note: '用户报名' },
      })
      return {
        status,
        waitlistSeq,
        message: status === 'enrolled' ? '报名成功' : status === 'waitlisted' ? `已进入候补（第 ${waitlistSeq} 位）` : '报名已提交，等待审核',
      }
    })
  }

  /** 取消报名：公告期限内直接办理；超期提示走请假/负责人审核。释放名额后按规则递补。 */
  async cancelRegistration(userId: string, activityId: string, reason?: string): Promise<{ status: string; promoted?: string }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      const activity = await tx.activity.findUnique({ where: { id: activityId } })
      if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
      const reg = await tx.activityRegistration.findUnique({ where: { activityId_userId: { activityId, userId } } })
      if (!reg || !['enrolled', 'waitlisted', 'pending_approval'].includes(reg.status)) {
        throw new ActivityError('没有可取消的报名', 'NO_REGISTRATION')
      }
      const now = new Date()
      if (activity.cancelDeadline && activity.cancelDeadline < now && reg.status === 'enrolled') {
        throw new ActivityError('已过取消截止，请提交请假申请由负责人审核', 'CANCEL_DEADLINE_PASSED')
      }
      await tx.activityRegistration.update({
        where: { id: reg.id },
        data: { status: 'cancelled', cancelledAt: now, cancelReason: reason, revision: { increment: 1 } },
      })

      // 候补递补：未截止 + 按顺序第一位 + 容量允许
      let promoted: string | undefined
      if (reg.status === 'enrolled' && (!activity.registerDeadline || activity.registerDeadline >= now)) {
        const next = await tx.activityRegistration.findFirst({
          where: { activityId, status: 'waitlisted' },
          orderBy: [{ waitlistSeq: 'asc' }, { createdAt: 'asc' }],
        })
        if (next) {
          if (activity.waitlistConfirmHours) {
            await tx.activityRegistration.update({
              where: { id: next.id },
              data: {
                status: 'pending_approval',
                confirmDeadline: new Date(now.getTime() + activity.waitlistConfirmHours * 3600_000),
                revision: { increment: 1 },
              },
            })
            promoted = 'confirm_required'
          } else {
            await tx.activityRegistration.update({
              where: { id: next.id },
              data: { status: 'enrolled', acceptedAt: now, revision: { increment: 1 } },
            })
            promoted = 'enrolled'
          }
        }
      }
      return { status: 'cancelled', promoted }
    })
  }

  /** 必到名单（独立于自愿报名） */
  async setRequiredParticipants(actor: SessionActor, activityId: string, userIds: string[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const activity = await tx.activity.findUnique({ where: { id: activityId } })
      if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
      for (const userId of userIds) {
        await tx.activityParticipant.upsert({
          where: { activityId_userId: { activityId, userId } },
          create: { id: newId(), activityId, userId, required: true },
          update: { required: true },
        })
      }
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.set_required',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `设置必到名单 ${userIds.length} 人`,
    })
  }

  /** 请假申请 */
  async requestLeave(userId: string, activityId: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new ActivityError('请假必须说明原因', 'REASON_REQUIRED')
    const activity = await this.db.activity.findUnique({ where: { id: activityId } })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (activity.leaveDeadline && activity.leaveDeadline < new Date()) {
      throw new ActivityError('请假申请已截止，请联系现场负责人', 'LEAVE_DEADLINE_PASSED')
    }
    await this.db.leaveRequest.upsert({
      where: { activityId_userId: { activityId, userId } },
      create: { id: newId(), activityId, userId, reason },
      update: { reason, status: 'pending' },
    })
  }

  /** 远程参赛申请（独立审批事实；点击不等于取得计分许可） */
  async requestRemote(userId: string, activityId: string, reason: string, monthKeyStr: string): Promise<void> {
    const activity = await this.db.activity.findUnique({ where: { id: activityId } })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (!activity.remoteAllowed) throw new ActivityError('本活动未开放远程参赛', 'REMOTE_NOT_ALLOWED')
    await this.db.remotePermission.upsert({
      where: { activityId_userId: { activityId, userId } },
      create: { id: newId(), activityId, userId, reason, monthKey: monthKeyStr },
      update: { reason, status: 'pending' },
    })
  }

  /** 活动目录（用户）：标签 + 筛选 + 分页；卡片含本人状态 */
  async listForUser(userId: string | null, filters: { tab?: string; type?: string; q?: string; cursor?: string }) {
    const now = new Date()
    const where: Record<string, unknown> = { status: 'published' }
    if (filters.type) where.type = filters.type
    if (filters.q) where.title = { contains: filters.q, mode: 'insensitive' }
    if (filters.tab === 'open') where.registerDeadline = { gte: now }
    if (filters.tab === 'ongoing') where.AND = [{ startAt: { lte: now } }, { endAt: { gte: now } }]
    if (filters.tab === 'ended') where.endAt = { lt: now }
    if (filters.tab === 'mine' && userId) {
      where.registrations = { some: { userId, status: { in: ['enrolled', 'waitlisted', 'pending_approval'] } } }
    }
    const rows = await this.db.activity.findMany({
      where,
      orderBy: { startAt: 'desc' },
      take: 21,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        registrations: userId ? { where: { userId } } : false,
        policy: true,
        venueBindings: { include: { venueVersion: { include: { venue: true } } } },
        venueVersion: { include: { venue: true } },
        _count: { select: { registrations: { where: { status: 'enrolled' } }, participants: { where: { required: true } } } },
      },
    })
    const nextCursor = rows.length > 20 ? rows.pop()!.id : undefined
    return {
      items: rows.map((a) => this.toCardDto(a)),
      nextCursor,
    }
  }

  private toCardDto(a: {
    id: string; type: string; platform: string | null; platformContestId: string | null; title: string
    startAt: Date; endAt: Date; registerDeadline: Date | null; cancelDeadline: Date | null
    capacity: number | null; waitlistCapacity: number | null; remoteAllowed: boolean
    requireValidSubmission: boolean
    registrations?: Array<{ status: string; waitlistSeq: number | null }>
    _count: { registrations: number; participants: number }
    policy: { policy: string } | null
    venueBindings: Array<{ venueVersion: { room: string | null; building: string | null; venue: { name: string } } }>
    venueVersion: { room: string | null; building: string | null; venue: { name: string } } | null
  }) {
    const primary = a.venueVersion ?? a.venueBindings[0]?.venueVersion ?? null
    return {
      id: a.id,
      type: a.type,
      platform: a.platform,
      platformContestId: a.platformContestId,
      title: a.title,
      startAt: a.startAt.toISOString(),
      endAt: a.endAt.toISOString(),
      registerDeadline: a.registerDeadline?.toISOString() ?? null,
      cancelDeadline: a.cancelDeadline?.toISOString() ?? null,
      capacity: a.capacity,
      enrolledCount: a._count.registrations,
      requiredCount: a._count.participants,
      waitlistCapacity: a.waitlistCapacity,
      venue: primary ? { name: primary.venue.name, building: primary.building, room: primary.room } : null,
      attendancePolicy: a.policy?.policy ?? null,
      remoteAllowed: a.remoteAllowed,
      requireValidSubmission: a.requireValidSubmission,
      myRegistration: a.registrations?.[0]
        ? { status: a.registrations[0].status, waitlistSeq: a.registrations[0].waitlistSeq }
        : null,
    }
  }

  /** 活动详情（用户） */
  async detailForUser(userId: string | null, activityId: string) {
    return this.loadDetail(userId, activityId)
  }

  /** 管理详情只读取配置；报名与出勤名单由各自授权接口提供。 */
  async detailForAdmin(activityId: string) {
    return this.loadDetail(null, activityId)
  }

  private async loadDetail(userId: string | null, activityId: string) {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      include: {
        policy: true,
        registrations: userId ? { where: { userId } } : false,
        participants: userId ? { where: { userId } } : false,
        leaveRequests: userId ? { where: { userId } } : false,
        remotePermissions: userId ? { where: { userId } } : false,
        checkpoints: userId ? { where: { userId } } : false,
        venueBindings: { include: { venueVersion: { include: { venue: true } } } },
        venueVersion: { include: { venue: true } },
      },
    })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    return activity
  }
}
