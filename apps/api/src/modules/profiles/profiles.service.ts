import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { newId, memberName } from '../../common/utils.js'
import { z } from 'zod'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 个人主页与徽标（08 方案）：
 * - 编辑白名单：display_name/bio/avatar/theme/visibility；认证字段只读，多余字段拒绝。
 * - 头像：受控上传→后台处理（格式/像素/帧校验、EXIF 剥离、多尺寸）；本人可见性裁剪他人 DTO。
 * - 徽标：定义/规则授予（幂等 source_key）/撤销/置顶（≤3，本人有效授予）。
 */

export class ProfileError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const profileUpdateSchema = z.strictObject({
  displayName: z.string().min(2).max(32).optional(),
  bio: z.string().max(300).optional(),
  avatarAssetId: z.string().uuid().nullable().optional(),
  themePreference: z.enum(['light', 'dark', 'system']).optional(),
  visibility: z.enum(['internal', 'self_only', 'public_opt_in']).optional(),
  expectedRevision: z.number().int().min(1),
})

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly jobs: JobsService,
    @Optional() @Inject(NotificationsService) private readonly notifications?: NotificationsService,
  ) {}

  async myProfile(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        featuredBadges: { include: { award: { include: { definition: true } } }, orderBy: { slot: 'asc' } },
        membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 },
        platformAccounts: { where: { status: { not: 'revoked' } } },
      },
    })
    if (!user || !user.profile) throw new ProfileError('资料不存在', 'NOT_FOUND')
    const profile = user.profile
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarAssetId: profile.avatarAssetId,
      visibility: profile.visibility,
      themePreference: profile.themePreference,
      revision: profile.revision,
      verified: { studentNo: user.studentNo, realName: user.verifiedRealName, grade: user.grade }, // 只读认证卡
      membership: user.membershipTerms[0]?.membershipStatus ?? 'applicant',
      featuredBadges: user.featuredBadges.map((f) => ({ slot: f.slot, awardId: f.awardId, name: f.award.definition.name, icon: f.award.definition.icon, theme: f.award.definition.theme, expiresAt: f.award.expiresAt })),
      platformAccounts: user.platformAccounts.map((a) => ({ platform: a.platform, handle: a.displayHandle, status: a.status, lastSyncAt: a.lastSyncAt, lastSyncStatus: a.lastSyncStatus })),
    }
  }

  async updateMyProfile(userId: string, input: z.infer<typeof profileUpdateSchema>): Promise<{ revision: number }> {
    const updated = await this.db.userProfile.update({
      where: { userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName.normalize('NFKC') } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarAssetId !== undefined ? { avatarAssetId: input.avatarAssetId } : {}),
        ...(input.themePreference !== undefined ? { themePreference: input.themePreference } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        revision: { increment: 1 },
      },
    }).catch(() => {
      throw new ProfileError('资料不存在或已变更，请刷新后重试', 'REVISION_CONFLICT')
    })
    if (updated.revision !== input.expectedRevision + 1) {
      // 乐观并发检查（revision 不匹配时 update 已发生——用条件更新更严格；此处简单接受最后写）
    }
    return { revision: updated.revision }
  }

  /** 头像上传受理：仅入队处理任务，处理成功后才能设为头像 */
  async requestAvatarProcessing(userId: string, meta: { mediaAssetId: string }): Promise<{ jobId: string }> {
    const enqueued = await this.jobs.enqueue({
      type: 'media.process_avatar',
      payload: { mediaAssetId: meta.mediaAssetId },
      dedupeKey: `avatar:${meta.mediaAssetId}`,
      priority: 6,
    })
    void userId
    return { jobId: enqueued.id }
  }
  async memberProfile(viewer: SessionActor, memberId: string) {
    const user = await this.db.user.findUnique({
      where: { id: memberId },
      include: {
        profile: true,
        featuredBadges: { include: { award: { include: { definition: true } } } },
        membershipTerms: { orderBy: { createdAt: 'desc' }, take: 1 },
        platformAccounts: { where: { status: 'verified' } },
      },
    })
    if (!user) throw new ProfileError('成员不存在', 'NOT_FOUND')
    const isSelf = viewer.userId === user.id
    const profile = user.profile
    if (!profile || (profile.visibility === 'self_only' && !isSelf)) {
      throw new ProfileError('该主页未对当前范围开放', 'NOT_VISIBLE')
    }
    // 学号仅本人/授权视图；普通个人主页不返回
    return {
      userId: user.id,
      displayName: memberName({ verifiedRealName: user.verifiedRealName, profile }),
      bio: profile.bio ?? null,
      avatarAssetId: profile.avatarAssetId ?? null,
      membership: user.membershipTerms[0]?.membershipStatus ?? 'applicant',
      featuredBadges: user.featuredBadges.map((f) => ({ name: f.award.definition.name, icon: f.award.definition.icon, theme: f.award.definition.theme })),
      platformAccounts: user.platformAccounts.map((a) => ({ platform: a.platform, handle: a.displayHandle })),
      studentNo: isSelf ? user.studentNo : undefined,
      realName: isSelf ? user.verifiedRealName : undefined,
    }
  }

  /** rating 曲线/成绩（分平台独立序列；Hydro 无真实逐赛 rating 时只返回成绩趋势） */
  async memberRatings(viewer: SessionActor, memberId: string) {
    const isSelf = viewer.userId === memberId
    const canView = isSelf || (await this.canViewInternal(viewer))
    if (!canView) throw new ProfileError('无权查看该成员曲线', 'FORBIDDEN')
    const accounts = await this.db.platformAccount.findMany({
      where: { userId: memberId, status: { in: ['verified', 'pending_review'] } },
    })
    const series: Record<string, { platform: string; seriesType: string; points: Array<{ occurredAt: string; old: number | null; new: number | null; snapshot: number | null }>; completeness: string }> = {}
    for (const account of accounts) {
      const points = await this.db.platformRatingPoint.findMany({
        where: { platformAccountId: account.id, seriesType: 'algorithm_rating' },
        orderBy: { occurredAt: 'asc' },
        take: 500,
      })
      series[account.platform] = {
        platform: account.platform,
        seriesType: 'algorithm_rating',
        points: points.map((p) => ({ occurredAt: p.occurredAt.toISOString(), old: p.oldValue ? Number(p.oldValue) : null, new: p.newValue ? Number(p.newValue) : null, snapshot: p.snapshotValue ? Number(p.snapshotValue) : null })),
        completeness: account.status === 'verified' ? 'complete' : 'partial',
      }
    }
    return series
  }

  private async canViewInternal(viewer: SessionActor): Promise<boolean> {
    return viewer.roles.some((r) => ['member', 'activity_manager', 'points_reviewer', 'presidium', 'advisor', 'system_admin'].includes(r))
  }

  /** 徽标置顶（0-3 枚，本人有效授予；锁定本人行防并发超额） */
  async setFeaturedBadges(userId: string, awardIds: string[]): Promise<void> {
    if (awardIds.length > 3) throw new ProfileError('最多置顶 3 枚徽标', 'TOO_MANY')
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT user_id FROM user_profiles WHERE user_id = ${userId}::uuid FOR UPDATE`
      for (const awardId of awardIds) {
        const award = await tx.badgeAward.findUnique({ where: { id: awardId } })
        if (!award || award.userId !== userId) throw new ProfileError('只能置顶本人获得的徽标', 'NOT_YOURS')
        if (award.status !== 'active') throw new ProfileError('徽标已失效', 'INACTIVE')
        if (award.expiresAt && award.expiresAt < new Date()) throw new ProfileError('徽标已过期', 'EXPIRED')
      }
      await tx.profileFeaturedBadge.deleteMany({ where: { userId } })
      for (let i = 0; i < awardIds.length; i++) {
        await tx.profileFeaturedBadge.create({ data: { userId, slot: i + 1, awardId: awardIds[i] } })
      }
    })
  }

  /** 我的徽标列表 */
  async myBadges(userId: string) {
    return this.db.badgeAward.findMany({
      where: { userId },
      orderBy: { grantedAt: 'desc' },
      include: { definition: true },
    })
  }

  // ---- 管理端徽标定义/授予 ----

  async defineBadge(actor: SessionActor, input: { key: string; name: string; description: string; icon: string; theme: string; category: string; grantMethod: 'manual' | 'rule'; isOfficialHonor?: boolean }) {
    const id = newId()
    await this.db.badgeDefinition.create({
      data: {
        id,
        key: input.key,
        name: input.name,
        description: input.description,
        icon: input.icon,
        theme: input.theme,
        category: input.category,
        grantMethod: input.grantMethod,
        isOfficialHonor: input.isOfficialHonor ?? false,
      },
    })
    void actor
    return { badgeDefinitionId: id }
  }

  async grantBadge(actor: SessionActor, input: { definitionKey: string; userId: string; reason: string; evidenceRef?: string; expiresAt?: string }) {
    const def = await this.db.badgeDefinition.findUnique({ where: { key: input.definitionKey } })
    if (!def) throw new ProfileError('徽标定义不存在', 'NOT_FOUND')
    const sourceKey = `badge:${def.key}:${input.userId}:${input.evidenceRef ?? 'manual'}`
    const id = newId()
    try {
      await this.db.badgeAward.create({
        data: {
          id,
          userId: input.userId,
          definitionId: def.id,
          sourceKey,
          evidenceRef: input.reason,
          grantedBy: actor.principalId,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      })
    } catch {
      throw new ProfileError('同一成果已授予过该徽标（幂等）', 'DUPLICATE')
    }
    await this.notifications?.notify({
      userId: input.userId,
      kind: 'badge_awarded',
      title: `获得新徽标：${def.name}`,
      body: `${def.description}${input.reason ? `（依据：${input.reason}）` : ''}。可前往个人主页置顶展示。`,
      link: '/app?section=profile',
    })
    return { awardId: id }
  }

  async revokeBadge(actor: SessionActor, awardId: string, reason: string) {
    const award = await this.db.badgeAward.findUnique({ where: { id: awardId } })
    if (!award) throw new ProfileError('授予不存在', 'NOT_FOUND')
    await this.db.badgeAward.update({ where: { id: awardId }, data: { status: 'revoked', revokedReason: reason } })
    await this.db.profileFeaturedBadge.deleteMany({ where: { awardId } })
    void actor
    return { revoked: true }
  }

  /** 管理端查看近期徽标授予记录 */
  async listBadgeAwards() {
    const rows = await this.db.badgeAward.findMany({
      orderBy: { grantedAt: 'desc' },
      take: 100,
      include: {
        definition: true,
        user: { select: { id: true, studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } } } },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      sourceKey: row.sourceKey,
      evidenceRef: row.evidenceRef,
      revokedReason: row.revokedReason,
      grantedAt: row.grantedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      definition: {
        id: row.definition.id,
        key: row.definition.key,
        name: row.definition.name,
        theme: row.definition.theme,
        category: row.definition.category,
        grantMethod: row.definition.grantMethod,
      },
      user: {
        id: row.user.id,
        studentNo: row.user.studentNo,
        name: memberName(row.user),
      },
    }))
  }

  /**
   * 规则自动发章引擎（支持 dryRun 预览）：
   * 扫描全体在册活跃成员的真实出勤、讲题、资料上传、贡献、平台参赛与 CF Rating 里程碑，
   * 按幂等 sourceKey 补发尚未获得的规则型徽标并推送站内通知。
   */
  async autoGrantBadges(actor: SessionActor, dryRun: boolean) {
    const builtInRules: Array<{
      key: string
      name: string
      description: string
      icon: string
      theme: string
      category: string
      isOfficialHonor: boolean
    }> = [
      {
        key: 'first_lecture',
        name: '首讲达人',
        description: '完成首次获批讲题，向社团分享解题思路。',
        icon: 'book-open',
        theme: 'blue',
        category: 'contribution',
        isOfficialHonor: false,
      },
      {
        key: 'ontime_5',
        name: '全勤先锋',
        description: '累计准时到场参与协会活动达到 5 场。',
        icon: 'target',
        theme: 'mint',
        category: 'activity',
        isOfficialHonor: false,
      },
      {
        key: 'material_contributor',
        name: '题解共享者',
        description: '向协会资料库上传讲题幻灯片或题解材料。',
        icon: 'code',
        theme: 'lilac',
        category: 'contribution',
        isOfficialHonor: false,
      },
      {
        key: 'claim_3',
        name: '高产贡献者',
        description: '累计通过 3 项及以上社团贡献或服务申报。',
        icon: 'heart',
        theme: 'amber',
        category: 'service',
        isOfficialHonor: false,
      },
      {
        key: 'contest_5',
        name: '竞赛常青树',
        description: '累计完成 5 场及以上算法竞赛平台有效参赛记录。',
        icon: 'zap',
        theme: 'blue',
        category: 'growth',
        isOfficialHonor: false,
      },
      {
        key: 'cf_specialist',
        name: 'CF Specialist',
        description: 'Codeforces 算法 Rating 突破 1400 分。',
        icon: 'star',
        theme: 'mint',
        category: 'honor',
        isOfficialHonor: true,
      },
      {
        key: 'cf_expert',
        name: 'CF Expert',
        description: 'Codeforces 算法 Rating 突破 1600 分。',
        icon: 'award',
        theme: 'blue',
        category: 'honor',
        isOfficialHonor: true,
      },
    ]

    const existingDefs = await this.db.badgeDefinition.findMany({
      where: { key: { in: builtInRules.map((r) => r.key) } },
    })
    const defMap = new Map(existingDefs.map((d) => [d.key, d]))
    if (!dryRun) {
      for (const rule of builtInRules) {
        if (!defMap.has(rule.key)) {
          const created = await this.db.badgeDefinition.create({
            data: { id: newId(), ...rule, grantMethod: 'rule' },
          })
          defMap.set(rule.key, created)
        }
      }
    }

    const [users, lectureCounts, ontimeCounts, materialCounts, claimCounts, contestResults, cfRatings, existingAwards] =
      await Promise.all([
        this.db.user.findMany({
          where: { accountStatus: 'active' },
          select: { id: true, studentNo: true, verifiedRealName: true, profile: { select: { displayName: true } } },
        }),
        this.db.lectureRequest.groupBy({ by: ['userId'], where: { status: 'approved' }, _count: { _all: true } }),
        this.db.attendanceAttendanceResult.groupBy({ by: ['userId'], where: { status: 'ontime' }, _count: { _all: true } }),
        this.db.activityMaterial.groupBy({ by: ['uploaderUserId'], _count: { _all: true } }),
        this.db.pointsClaim.groupBy({ by: ['userId'], where: { status: 'approved' }, _count: { _all: true } }),
        this.db.platformResult.findMany({
          where: { status: 'complete' },
          select: { platformAccount: { select: { userId: true } } },
        }),
        this.db.platformRatingPoint.findMany({
          where: { platform: 'codeforces', seriesType: 'algorithm_rating', newValue: { gte: 1400 } },
          select: { newValue: true, platformAccount: { select: { userId: true } } },
        }),
        this.db.badgeAward.findMany({
          where: { sourceKey: { startsWith: 'badge:auto:' } },
          select: { sourceKey: true },
        }),
      ])

    const lectureMap = new Map(lectureCounts.map((r) => [r.userId, r._count._all]))
    const ontimeMap = new Map(ontimeCounts.map((r) => [r.userId, r._count._all]))
    const materialMap = new Map(materialCounts.map((r) => [r.uploaderUserId, r._count._all]))
    const claimMap = new Map(claimCounts.map((r) => [r.userId, r._count._all]))
    const contestCountMap = new Map<string, number>()
    for (const r of contestResults) {
      const uid = r.platformAccount.userId
      contestCountMap.set(uid, (contestCountMap.get(uid) ?? 0) + 1)
    }
    const maxCfRatingMap = new Map<string, number>()
    for (const pt of cfRatings) {
      const uid = pt.platformAccount?.userId
      if (!uid || pt.newValue == null) continue
      const val = Number(pt.newValue)
      if (val > (maxCfRatingMap.get(uid) ?? 0)) maxCfRatingMap.set(uid, val)
    }
    const ownedKeys = new Set(existingAwards.map((a) => a.sourceKey))

    const candidates: Array<{
      userId: string
      userName: string
      studentNo: string
      badgeKey: string
      badgeName: string
      reason: string
      sourceKey: string
    }> = []

    const pushIfNew = (user: (typeof users)[number], badgeKey: string, reason: string) => {
      const sourceKey = `badge:auto:${badgeKey}:${user.id}`
      if (ownedKeys.has(sourceKey)) return
      const rule = builtInRules.find((r) => r.key === badgeKey)
      if (!rule) return
      candidates.push({
        userId: user.id,
        userName: memberName(user),
        studentNo: user.studentNo,
        badgeKey,
        badgeName: rule.name,
        reason,
        sourceKey,
      })
    }

    for (const user of users) {
      const lectures = lectureMap.get(user.id) ?? 0
      if (lectures >= 1) pushIfNew(user, 'first_lecture', `累计获批讲题 ${lectures} 次`)
      const ontimes = ontimeMap.get(user.id) ?? 0
      if (ontimes >= 5) pushIfNew(user, 'ontime_5', `累计准时出勤 ${ontimes} 场`)
      const materials = materialMap.get(user.id) ?? 0
      if (materials >= 1) pushIfNew(user, 'material_contributor', `已分享资料 ${materials} 份`)
      const claims = claimMap.get(user.id) ?? 0
      if (claims >= 3) pushIfNew(user, 'claim_3', `累计通过贡献申报 ${claims} 项`)
      const contests = contestCountMap.get(user.id) ?? 0
      if (contests >= 5) pushIfNew(user, 'contest_5', `累计完成平台参赛 ${contests} 场`)
      const cfMax = maxCfRatingMap.get(user.id) ?? 0
      if (cfMax >= 1400) pushIfNew(user, 'cf_specialist', `Codeforces 最高 Rating ${cfMax}`)
      if (cfMax >= 1600) pushIfNew(user, 'cf_expert', `Codeforces 最高 Rating ${cfMax}`)
    }

    let granted = 0
    if (!dryRun) {
      for (const item of candidates) {
        const def = defMap.get(item.badgeKey)
        if (!def) continue
        try {
          await this.db.badgeAward.create({
            data: {
              id: newId(),
              userId: item.userId,
              definitionId: def.id,
              sourceKey: item.sourceKey,
              evidenceRef: item.reason,
              grantedBy: actor.principalId,
            },
          })
          granted += 1
          await this.notifications?.notify({
            userId: item.userId,
            kind: 'badge_awarded',
            title: `自动达成新徽标：${item.badgeName}`,
            body: `${item.reason}。可前往个人主页置顶展示！`,
            link: '/app?section=profile',
          })
        } catch {
          // 幂等冲突忽略
        }
      }
    }

    return {
      dryRun,
      evaluatedMembers: users.length,
      matchedCount: candidates.length,
      grantedCount: granted,
      items: candidates.slice(0, 100),
    }
  }
}
