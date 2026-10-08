import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { VenueService } from '../venues/venue.service.js'
import { newId } from '../../common/utils.js'
import { actorCan } from '../../common/guards.js'
import { ContestStandingsService, contestExternalUrl, type StandingsSnapshot } from './contest-standings.service.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'
import { Prisma, attendanceDeadline } from '@acm/db'

/**
 * 活动模块（01/02/03 方案）：
 * - 三种来源：导入平台赛事（202+job 建草稿）、自定义比赛、普通活动。
 * - 发布前固定策略快照（policyVersion/scoringConfig/围栏快照）；发布校验地点认证覆盖窗口与能力。
 * - 报名：最后名额原子分配（活动行锁 + 唯一约束兜底）；候补按公告递补；必到成员现场签到成功后自动报名。
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
      /** 活动结束时为已签到未签退者自动补记签退（按结束时间，method=AUTO） */
      autoCheckout: z.boolean().optional(),
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

/** 需要成员先绑定平台账号才能报名的平台（榜单按绑定账号计分） */
const BINDABLE_PLATFORMS = new Set(['nowcoder', 'codeforces', 'atcoder'])
const PLATFORM_NAMES: Record<string, string> = { nowcoder: '牛客', codeforces: 'Codeforces', atcoder: 'AtCoder' }

export const lectureRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500).nullable().optional(),
})
export type LectureRatingInput = z.infer<typeof lectureRatingSchema>

/** 到场口径：缺席/请假/待定不具备讲题评价资格 */
const PRESENT_ATTENDANCE = ['ontime', 'late', 'early_leave', 'late_and_early', 'remote_approved']
/** 匿名留言对讲题人的最小样本量：样本过少时逐条留言等于点名，仅活动负责人可见 */
const RATING_COMMENT_REVEAL_MIN = 3

/** 评分汇总：均值保留 1 位小数，distribution 为 1–5 星各自人数 */
function summarizeRatings(ratings: Array<{ score: number }>): { count: number; average: number; distribution: number[] } {
  const scores = ratings.map((r) => r.score)
  const sum = scores.reduce((acc, v) => acc + v, 0)
  return {
    count: scores.length,
    average: scores.length > 0 ? Math.round((sum / scores.length) * 10) / 10 : 0,
    distribution: [1, 2, 3, 4, 5].map((s) => scores.filter((v) => v === s).length),
  }
}

/** 讲题满意度聚合：评价人身份不出现在任何字段里 */
export interface LectureRatingView {
  lectureRequestId: string
  lecturerUserId: string
  lecturerName: string
  topic: string | null
  /** 本人是否即讲题人（讲题人不自评） */
  isLecturer: boolean
  canRate: boolean
  /** 不可评价时的原因文案，前端直接展示 */
  blockedReason: string | null
  myScore: number | null
  myComment: string | null
  /** 聚合值仅讲题人本人与 activity.manage 可见，其余人为 null */
  stats: { count: number; average: number; distribution: number[] } | null
  /** 匿名留言：负责人始终可见，讲题人需样本达到 RATING_COMMENT_REVEAL_MIN */
  comments: Array<{ id: string; score: number; comment: string; createdAt: string }> | null
  /** 留言因样本不足而暂不展示的条数（讲题人视角） */
  hiddenComments: number
}

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
            autoCheckout: input.attendancePolicy.autoCheckout ?? false,
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
  /** 删除活动：仅草稿且无任何报名/参与/出勤/材料数据（已发布活动走取消/归档，保留记录） */
  async deleteDraft(actor: SessionActor, activityId: string): Promise<void> {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      include: {
        policy: true,
        _count: { select: { registrations: true, participants: true, checkpoints: true, materials: true, lectureRequests: true, leaveRequests: true, remotePermissions: true } },
      },
    })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (activity.status !== 'draft') throw new ActivityError('仅草稿可删除；已发布活动请取消或归档以保留报名与出勤记录', 'STATE_INVALID')
    const used = activity._count.registrations + activity._count.participants + activity._count.checkpoints
      + activity._count.materials + activity._count.lectureRequests + activity._count.leaveRequests + activity._count.remotePermissions
    if (used > 0) throw new ActivityError('已有报名/参与/出勤/材料数据，不能删除；请改用取消或归档', 'STATE_INVALID')
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      await tx.activityVenueBinding.deleteMany({ where: { activityId } })
      await tx.attendancePolicy.deleteMany({ where: { activityId } })
      await tx.activity.delete({ where: { id: activityId } })
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.delete',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `删除草稿活动：${activity.title}`,
    })
  }

  /** 批量删除草稿活动：逐项走删除校验，失败项跳过并汇总原因（部分成功） */
  async batchDeleteDrafts(actor: SessionActor, activityIds: string[]): Promise<{ deletedCount: number; skipped: Array<{ id: string; label: string; reason: string }> }> {
    const skipped: Array<{ id: string; label: string; reason: string }> = []
    let deletedCount = 0
    for (const activityId of activityIds) {
      const activity = await this.db.activity.findUnique({ where: { id: activityId }, select: { title: true } })
      const label = activity?.title ?? activityId.slice(0, 8)
      try {
        await this.deleteDraft(actor, activityId)
        deletedCount++
      } catch (error) {
        skipped.push({ id: activityId, label, reason: error instanceof ActivityError ? error.message : '删除失败' })
      }
    }
    return { deletedCount, skipped }
  }

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
      await this.scheduleAttendanceSettlement(tx, activityId, attendanceDeadline(activity))
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
   * - 必到成员现场签到成功后自动确认报名，其他成员须先取得报名资格。
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
      // 平台赛靠绑定账号匹配榜单计分：没绑定就无法计成绩，报名前必须先绑定
      if (activity.platform && BINDABLE_PLATFORMS.has(activity.platform)) {
        const bound = await tx.platformAccount.findFirst({ where: { userId, platform: activity.platform, status: { not: 'revoked' } }, select: { id: true } })
        if (!bound) throw new ActivityError(`本场是${PLATFORM_NAMES[activity.platform]}比赛，请先在「我的 → 平台账号」绑定${PLATFORM_NAMES[activity.platform]}账号后再报名`, 'NEEDS_PLATFORM_BIND')
      }

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
      const participant = await tx.activityParticipant.findUnique({ where: { activityId_userId: { activityId, userId } } })
      if (participant?.required) throw new ActivityError('必到成员无法取消报名；如需缺席请提交请假申请', 'REQUIRED_PARTICIPANT')
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
      const enrolledCount = await tx.activityRegistration.count({ where: { activityId, status: 'enrolled' } })
      if (reg.status === 'enrolled' && (activity.capacity == null || enrolledCount < activity.capacity) && (!activity.registerDeadline || activity.registerDeadline >= now)) {
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

  /** 必到名单独立保存；加入名单不报名，发布时冻结，现场签到成功才自动报名。 */
  async setRequiredParticipants(actor: SessionActor, activityId: string, userIds: string[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
      const activity = await tx.activity.findUnique({ where: { id: activityId }, include: { policy: true } })
      if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
      if (!['draft', 'published'].includes(activity.status)) throw new ActivityError('已取消或归档的活动不能设置必到名单', 'STATE_INVALID')
      for (const userId of new Set(userIds)) {
        await tx.activityParticipant.upsert({
          where: { activityId_userId: { activityId, userId } },
          create: { id: newId(), activityId, userId, required: true, frozenAt: activity.status === 'published' ? new Date() : null },
          update: { required: true, ...(activity.status === 'published' ? { frozenAt: new Date() } : {}) },
        })
      }
      if (activity.status === 'published') await this.scheduleAttendanceSettlement(tx, activityId, attendanceDeadline(activity))
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'activity.set_required',
      resourceType: 'activity',
      resourceId: activityId,
      summary: `设置必到名单 ${new Set(userIds).size} 人`,
    })
  }

  private async scheduleAttendanceSettlement(tx: Prisma.TransactionClient, activityId: string, deadline: Date) {
    const dedupeKey = `attendance-settle:${activityId}`
    const queued = await tx.job.findFirst({ where: { dedupeKey, status: { in: ['queued', 'running'] } } })
    if (!queued) await tx.job.create({ data: {
      id: newId(), type: 'activity.settle_attendance', payload: { activityId }, dedupeKey,
      runAfter: new Date(deadline.getTime() + 1), priority: 6,
    } })
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
    // 归档活动（含历史积分导入存档）留在「全部 / 已结束」里，成员可回看积分来源
    const where: Record<string, unknown> = { status: { in: ['published', 'archived'] } }
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

  /** 活动详情（用户）：附加平台赛事名、讲题/材料区数据与本次活动积分（手动入账带 activityId 的流水） */
  async detailForUser(userId: string | null, activityId: string, actor?: SessionActor) {
    const activity = await this.withContestMeta(await this.loadDetail(userId, activityId))
    if (!userId) return activity
    const lectureRatings = await this.lectureRatings(userId, activityId, actor)
    const platformBinding = activity.platform && BINDABLE_PLATFORMS.has(activity.platform)
      ? {
        platform: activity.platform,
        bound: (await this.db.platformAccount.count({ where: { userId, platform: activity.platform, status: { not: 'revoked' } } })) > 0,
      }
      : null
    const points = await this.db.pointsLedgerEntry.findMany({
      where: { status: 'approved', detail: { path: ['activityId'], equals: activityId } },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      include: { user: { select: { id: true, verifiedRealName: true, profile: { select: { displayName: true } } } } },
    })
    const byUser = new Map<string, { userId: string; name: string; total: number; count: number }>()
    for (const entry of points) {
      const name = entry.user.profile?.displayName ?? entry.user.verifiedRealName
      const current = byUser.get(entry.userId) ?? { userId: entry.userId, name, total: 0, count: 0 }
      current.total += Number(entry.amount)
      current.count += 1
      byUser.set(entry.userId, current)
    }
    const board = [...byUser.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    const mine = points.filter((entry) => entry.userId === userId)
    return Object.assign(activity, {
      lectureRatings,
      platformBinding,
      activityPoints: {
        mine: mine.map((entry) => ({
          amount: Number(entry.amount),
          category: entry.category,
          scoreMonth: entry.scoreMonth,
          note: ((entry.detail ?? {}) as { note?: string }).note ?? null,
          recordedAt: entry.recordedAt.toISOString(),
        })),
        myTotal: mine.reduce((sum, entry) => sum + Number(entry.amount), 0),
        board: board.map((row, index) => ({ ...row, rank: index + 1 })),
        totalAwarded: points.reduce((sum, entry) => sum + Number(entry.amount), 0),
      },
    })
  }

  /** 管理详情只读取配置；报名与出勤名单由各自授权接口提供。 */
  async detailForAdmin(activityId: string) {
    const activity = await this.loadDetail(null, activityId)
    return this.withContestMeta(activity)
  }

  private async withContestMeta<T extends { platform: string | null; platformContestId: string | null }>(
    activity: T,
  ): Promise<T & { contest: { name: string; sourceUrl: string | null; startTime: Date } | null }> {
    let contest: { name: string; sourceUrl: string | null; startTime: Date } | null = null
    if (activity.platform && activity.platformContestId) {
      const row = await this.db.platformContest.findUnique({
        where: { platform_externalContestId: { platform: activity.platform, externalContestId: activity.platformContestId } },
      })
      contest = row ? { name: row.name, sourceUrl: row.sourceUrl, startTime: row.startTime } : null
    }
    // Object.assign 保持泛型 T 的完整形状（对象展开会丢 include 字段的类型）
    return Object.assign(activity, { contest })
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
        lectureRequests: userId ? { where: { userId }, orderBy: { createdAt: 'desc' }, take: 1 } : false,
        materials: { orderBy: { createdAt: 'desc' }, include: { user: { select: { verifiedRealName: true, profile: { select: { displayName: true } } } } } },
        venueBindings: { include: { venueVersion: { include: { venue: true } } } },
        venueVersion: { include: { venue: true } },
      },
    })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    return activity
  }

  // ---------------- 讲题申请与活动材料（参与者详情页） ----------------

  /** 申请讲题：活动发布且未结束前可提交；被驳回后可重新提交 */
  async submitLectureRequest(userId: string, activityId: string, topic?: string): Promise<{ status: string }> {
    const activity = await this.db.activity.findUnique({ where: { id: activityId }, select: { status: true, endAt: true } })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (activity.status !== 'published') throw new ActivityError('活动未发布，暂不能申请讲题', 'STATE_INVALID')
    if (activity.endAt.getTime() <= Date.now()) throw new ActivityError('活动已结束，不能再申请讲题', 'STATE_INVALID')
    const existing = await this.db.lectureRequest.findUnique({ where: { activityId_userId: { activityId, userId } } })
    if (existing?.status === 'approved') throw new ActivityError('你已获得本活动的材料上传权限', 'ALREADY_GRANTED')
    if (existing?.status === 'pending') throw new ActivityError('申请审核中，请等待负责人审批', 'STATE_INVALID')
    const data = { topic: topic ?? null, status: 'pending', reviewNote: null, reviewedBy: null, reviewedAt: null }
    if (existing) {
      await this.db.lectureRequest.update({ where: { id: existing.id }, data })
    } else {
      await this.db.lectureRequest.create({ data: { id: newId(), activityId, userId, ...data } })
    }
    return { status: 'pending' }
  }

  /** 讲题审批队列（activity.manage） */
  async listLectureRequests(activityId: string) {
    return this.db.lectureRequest.findMany({
      where: { activityId },
      orderBy: [{ status: 'desc' }, { createdAt: 'asc' }],
      include: { user: { select: { id: true, verifiedRealName: true, studentNo: true, profile: { select: { displayName: true } } } } },
    })
  }

  async decideLectureRequest(actor: SessionActor, activityId: string, requestId: string, decision: 'approve' | 'reject', note?: string): Promise<void> {
    const request = await this.db.lectureRequest.findUnique({ where: { id: requestId } })
    if (!request || request.activityId !== activityId) throw new ActivityError('讲题申请不存在', 'NOT_FOUND')
    if (request.status !== 'pending') throw new ActivityError('该申请已处理过', 'STATE_INVALID')
    await this.db.lectureRequest.update({
      where: { id: requestId },
      data: { status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note ?? null, reviewedBy: actor.principalId, reviewedAt: new Date() },
    })
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: decision === 'approve' ? 'activity.lecture_approve' : 'activity.lecture_reject',
      resourceType: 'lecture_request',
      resourceId: requestId,
      summary: `${decision === 'approve' ? '批准' : '驳回'}讲题申请（活动 ${activityId}）${note ? `：${note.slice(0, 180)}` : ''}`,
    })
  }

  // ---------------- 讲题满意度评价 ----------------

  /**
   * 讲题满意度区块：列出本活动所有获批讲题人的评价状态。
   * 聚合值与留言按身份收敛（见 LectureRatingView）；评价人身份一律不出接口。
   */
  async lectureRatings(userId: string, activityId: string, actor?: SessionActor): Promise<LectureRatingView[]> {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      select: { endAt: true, policy: { select: { id: true } } },
    })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    const lectures = await this.db.lectureRequest.findMany({
      where: { activityId, status: 'approved' },
      orderBy: [{ reviewedAt: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: { select: { id: true, verifiedRealName: true, profile: { select: { displayName: true } } } },
        ratings: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (lectures.length === 0) return []
    const canManage = Boolean(actor && actorCan(actor, 'activity.manage'))
    const ended = activity.endAt.getTime() <= Date.now()
    const attended = await this.attendedForRating(userId, activityId, Boolean(activity.policy))
    return lectures.map((lecture) => {
      const isLecturer = lecture.userId === userId
      const mine = isLecturer ? null : lecture.ratings.find((r) => r.raterUserId === userId) ?? null
      const stats = summarizeRatings(lecture.ratings)
      const withComment = lecture.ratings.filter((r) => (r.comment ?? '').trim().length > 0)
      const commentsVisible = canManage || (isLecturer && stats.count >= RATING_COMMENT_REVEAL_MIN)
      let blockedReason: string | null = null
      if (isLecturer) blockedReason = '讲题人不对本人讲题评分'
      else if (!ended) blockedReason = '活动结束后开放满意度评分'
      else if (!attended) blockedReason = '仅本次活动的到场成员可以评分'
      return {
        lectureRequestId: lecture.id,
        lecturerUserId: lecture.userId,
        lecturerName: lecture.user.profile?.displayName ?? lecture.user.verifiedRealName,
        topic: lecture.topic,
        isLecturer,
        canRate: blockedReason === null,
        blockedReason,
        myScore: mine?.score ?? null,
        myComment: mine?.comment ?? null,
        stats: canManage || isLecturer ? stats : null,
        comments: commentsVisible
          ? withComment.map((r) => ({
              id: r.id,
              score: r.score,
              comment: (r.comment ?? '').trim(),
              createdAt: r.createdAt.toISOString(),
            }))
          : null,
        hiddenComments: commentsVisible ? 0 : withComment.length,
      }
    })
  }

  /**
   * 管理侧讲题满意度汇总（activity.manage）：供无学生账号的指导教师/负责人查看。
   * 同样不返回评价人身份；负责人需要据此跟进讲题质量，故匿名评语不设样本门槛。
   */
  async lectureRatingsForAdmin(activityId: string) {
    const lectures = await this.db.lectureRequest.findMany({
      where: { activityId, status: 'approved' },
      orderBy: [{ reviewedAt: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: { select: { id: true, studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } } } },
        ratings: { orderBy: { createdAt: 'desc' } },
      },
    })
    return lectures.map((lecture) => ({
      lectureRequestId: lecture.id,
      lecturerUserId: lecture.userId,
      lecturerName: lecture.user.profile?.displayName ?? lecture.user.verifiedRealName,
      studentNo: lecture.user.studentNo,
      topic: lecture.topic,
      stats: summarizeRatings(lecture.ratings),
      comments: lecture.ratings
        .filter((r) => (r.comment ?? '').trim().length > 0)
        .map((r) => ({
          id: r.id,
          score: r.score,
          comment: (r.comment ?? '').trim(),
          createdAt: r.createdAt.toISOString(),
        })),
    }))
  }

  /**
   * 评价资格：有入场打点或出勤认定为到场即可。
   * 活动未设签到环节时退回「已报名」口径，否则没有出勤结论的讲座会无人可评。
   */
  private async attendedForRating(userId: string, activityId: string, hasPolicy: boolean): Promise<boolean> {
    const [checkin, result] = await Promise.all([
      this.db.attendanceCheckpoint.findUnique({
        where: { activityId_userId_checkpoint: { activityId, userId, checkpoint: 'IN' } },
        select: { id: true },
      }),
      this.db.attendanceAttendanceResult.findUnique({
        where: { activityId_userId: { activityId, userId } },
        select: { status: true },
      }),
    ])
    if (checkin) return true
    if (result && PRESENT_ATTENDANCE.includes(result.status)) return true
    if (hasPolicy) return false
    const registration = await this.db.activityRegistration.findUnique({
      where: { activityId_userId: { activityId, userId } },
      select: { status: true },
    })
    return registration?.status === 'enrolled'
  }

  /** 提交或修改讲题评分：到场成员、活动结束后、每位讲题人一条，可改分改评语 */
  async submitLectureRating(
    userId: string, activityId: string, lectureRequestId: string, input: LectureRatingInput,
  ): Promise<{ score: number }> {
    const lecture = await this.loadRatableLecture(userId, activityId, lectureRequestId)
    const comment = input.comment?.trim() ? input.comment.trim() : null
    const existing = await this.db.lectureRating.findUnique({
      where: { lectureRequestId_raterUserId: { lectureRequestId: lecture.id, raterUserId: userId } },
      select: { id: true },
    })
    if (existing) {
      await this.db.lectureRating.update({ where: { id: existing.id }, data: { score: input.score, comment } })
    } else {
      await this.db.lectureRating.create({
        data: { id: newId(), lectureRequestId: lecture.id, raterUserId: userId, score: input.score, comment },
      })
    }
    await this.logRatingAudit(existing ? 'update' : 'create', lecture.id, activityId)
    return { score: input.score }
  }

  /** 撤销本人提交的讲题评分 */
  async deleteLectureRating(userId: string, activityId: string, lectureRequestId: string): Promise<void> {
    const lecture = await this.db.lectureRequest.findUnique({
      where: { id: lectureRequestId },
      select: { id: true, activityId: true },
    })
    if (!lecture || lecture.activityId !== activityId) throw new ActivityError('讲题不存在', 'NOT_FOUND')
    const existing = await this.db.lectureRating.findUnique({
      where: { lectureRequestId_raterUserId: { lectureRequestId: lecture.id, raterUserId: userId } },
      select: { id: true },
    })
    if (!existing) throw new ActivityError('你还没有提交该讲题的评分', 'NOT_FOUND')
    await this.db.lectureRating.delete({ where: { id: existing.id } })
    await this.logRatingAudit('delete', lecture.id, activityId)
  }

  private async loadRatableLecture(userId: string, activityId: string, lectureRequestId: string) {
    const lecture = await this.db.lectureRequest.findUnique({
      where: { id: lectureRequestId },
      select: {
        id: true, activityId: true, userId: true, status: true,
        activity: { select: { endAt: true, policy: { select: { id: true } } } },
      },
    })
    if (!lecture || lecture.activityId !== activityId) throw new ActivityError('讲题不存在', 'NOT_FOUND')
    if (lecture.status !== 'approved') throw new ActivityError('该讲题申请未获批准，暂不能评分', 'STATE_INVALID')
    if (lecture.userId === userId) throw new ActivityError('讲题人不对本人讲题评分', 'RECUSED')
    if (lecture.activity.endAt.getTime() > Date.now()) throw new ActivityError('活动结束后才能提交满意度评分', 'STATE_INVALID')
    const attended = await this.attendedForRating(userId, activityId, Boolean(lecture.activity.policy))
    if (!attended) throw new ActivityError('仅本次活动的到场成员可以评分', 'FORBIDDEN')
    return lecture
  }

  /** 审计只落讲题维度：写入评价人主体会把匿名评价反查出来 */
  private async logRatingAudit(kind: 'create' | 'update' | 'delete', lectureRequestId: string, activityId: string): Promise<void> {
    const label = kind === 'create' ? '提交' : kind === 'update' ? '修改' : '撤销'
    await this.audit.log({
      action: `activity.lecture_rating_${kind}`,
      resourceType: 'lecture_request',
      resourceId: lectureRequestId,
      summary: `${label}讲题满意度评分（活动 ${activityId}）`,
    })
  }

  /** 材料上传权限：讲题申请已批，或具备 activity.manage */
  async canUploadMaterials(actor: SessionActor | undefined, userId: string, activityId: string): Promise<boolean> {
    if (actor && actorCan(actor, 'activity.manage')) return true
    const request = await this.db.lectureRequest.findUnique({ where: { activityId_userId: { activityId, userId } } })
    return request?.status === 'approved'
  }

  private static readonly MATERIAL_MIME_WHITELIST = new Set([
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'text/markdown',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
  ])

  /** 上传活动材料（讲题幻灯片/题解）：≤20MiB，白名单类型，受控本地存储 */
  async createMaterial(
    actor: SessionActor | undefined,
    userId: string,
    activityId: string,
    file: { buffer: Buffer; mimetype: string; size: number; originalname?: string },
    input: { title: string; kind: string },
  ): Promise<{ materialId: string }> {
    const activity = await this.db.activity.findUnique({ where: { id: activityId }, select: { status: true, endAt: true } })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (!(await this.canUploadMaterials(actor, userId, activityId))) {
      throw new ActivityError('讲题申请获批后才能上传本活动材料', 'FORBIDDEN')
    }
    if (activity.endAt.getTime() + 14 * 24 * 3600_000 < Date.now()) throw new ActivityError('活动结束超过 14 天，材料上传已关闭', 'STATE_INVALID')
    if (file.size > 20 * 1024 * 1024) throw new ActivityError('单个材料不超过 20 MiB', 'PAYLOAD_TOO_LARGE')
    if (!ActivityService.MATERIAL_MIME_WHITELIST.has(file.mimetype)) throw new ActivityError('仅支持 PDF / Markdown / 文本 / Office 文档 / 图片 / ZIP', 'UNSUPPORTED_MEDIA')
    const fileName = (file.originalname ?? 'material').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180)
    const id = newId()
    const storageKey = `materials/${activityId}/${id}/source.bin`
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const target = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.buffer)
    await this.db.activityMaterial.create({
      data: {
        id, activityId, uploaderUserId: userId,
        title: input.title, kind: input.kind, fileName,
        mimeType: file.mimetype, sizeBytes: file.size, storageKey,
      },
    })
    return { materialId: id }
  }

  /** 材料元数据 + 绝对路径（下载授权：任意登录成员可见社团内部材料） */
  async materialForDownload(activityId: string, materialId: string): Promise<{ material: { fileName: string; mimeType: string | null; storageKey: string }; filePath: string }> {
    const material = await this.db.activityMaterial.findUnique({ where: { id: materialId } })
    if (!material || material.activityId !== activityId) throw new ActivityError('材料不存在', 'NOT_FOUND')
    const path = await import('node:path')
    return {
      material: { fileName: material.fileName, mimeType: material.mimeType, storageKey: material.storageKey },
      filePath: path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', material.storageKey),
    }
  }

  async deleteMaterial(actor: SessionActor, activityId: string, materialId: string): Promise<void> {
    const material = await this.db.activityMaterial.findUnique({ where: { id: materialId } })
    if (!material || material.activityId !== activityId) throw new ActivityError('材料不存在', 'NOT_FOUND')
    if (material.uploaderUserId !== actor.userId && !actorCan(actor, 'activity.manage')) {
      throw new ActivityError('只能删除本人上传的材料', 'FORBIDDEN')
    }
    await this.db.activityMaterial.delete({ where: { id: materialId } })
    const fs = await import('node:fs/promises')
    await fs.rm(`${process.env.STORAGE_LOCAL_DIR ?? './storage'}/${material.storageKey}`, { force: true }).catch(() => undefined)
  }

  /**
   * 平台榜社团映射（成员/管理端共用）：抓取平台榜 + 按绑定账号映射成员，
   * 返回题目、社团排行（含逐题明细）与有效参赛集合。
   */
  async platformClubRows(activityId: string, standings: ContestStandingsService) {
    const activity = await this.db.activity.findUnique({
      where: { id: activityId },
      select: { id: true, title: true, platform: true, platformContestId: true, endAt: true },
    })
    if (!activity) throw new ActivityError('活动不存在', 'NOT_FOUND')
    if (!activity.platform || !activity.platformContestId) throw new ActivityError('本活动未关联平台赛事', 'NOT_CONTEST')
    const contestUrl = contestExternalUrl(activity.platform, activity.platformContestId)
    const ended = activity.endAt.getTime() <= Date.now()
    const result = await standings.fetch(activity.platform, activity.platformContestId)
    if (!result.available) return { activity, contestUrl, ended, result, clubRows: [], clubRanking: [], problems: [], totalEntries: 0 }
    const { clubRows, clubRanking, problems, totalEntries } = await this.matchClubRows(activity.platform, result)
    return { activity, contestUrl, ended, result, clubRows, clubRanking, problems, totalEntries }
  }

  /** 平台榜单 → 社团成员行：按平台账号绑定（externalId / displayHandle）映射，按对题数、得分排序 */
  async matchClubRows(platform: string, result: StandingsSnapshot) {
    const accounts = await this.db.platformAccount.findMany({
      where: { platform, status: { not: 'revoked' } },
      select: {
        externalId: true, displayHandle: true, userId: true,
        user: { select: { id: true, studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } } } },
      },
    })
    const entryByHandle = new Map(result.entries.map((entry) => [entry.handle, entry]))
    const clubRows = accounts
      .map((account) => {
        const entry = entryByHandle.get(account.externalId) ?? (account.displayHandle ? entryByHandle.get(account.displayHandle) : undefined)
        if (!entry) return null
        return {
          userId: account.userId,
          studentNo: account.user.studentNo,
          name: account.user.profile?.displayName ?? account.user.verifiedRealName,
          handle: entry.handle,
          displayName: entry.displayName,
          platformRank: entry.rank,
          score: entry.score,
          solvedCount: entry.solvedCount,
          cells: entry.cells,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.solvedCount - a.solvedCount || b.score - a.score || a.name.localeCompare(b.name))
    let clubRank = 0
    // 社团排名会下发给成员端：不带学号
    const clubRanking = clubRows.map((row) => ({ ...row, cells: undefined, studentNo: undefined, clubRank: (clubRank += 1) }))
    const problems = result.problems.map((problem) => ({
      ...problem,
      clubSolved: clubRows.filter((row) => row.cells.some((cell) => cell.index === problem.index && cell.solved)).length,
    }))
    return { clubRows, clubRanking, problems, totalEntries: result.entries.length }
  }

  /**
   * 平台榜单（社团视角）：抓取平台榜 + 按平台账号绑定映射成员，
   * 输出题目（含外链与社团通过数）、我的成绩、社团对题数排名。
   */
  async activityStandings(userId: string, activityId: string, standings: ContestStandingsService) {
    const { activity, contestUrl, ended, result, clubRows, clubRanking, problems, totalEntries } = await this.platformClubRows(activityId, standings)
    if (!result.available) {
      return { ...result, contestUrl, ended }
    }
    const mine = clubRanking.find((row) => row.userId === userId)
    return {
      ...result,
      contestUrl,
      ended,
      problems,
      clubRanking,
      totalEntries,
      me: mine ? { ...mine, cells: mine.cells } : null,
      // entries 不外发（含非成员个人信息），只保留社团映射与统计
      entries: undefined,
    }
  }
}
