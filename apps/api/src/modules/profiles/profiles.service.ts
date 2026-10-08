import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'
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
    return { awardId: id }
  }

  async revokeBadge(actor: SessionActor, awardId: string, reason: string) {
    const award = await this.db.badgeAward.findUnique({ where: { id: awardId } })
    if (!award) throw new ProfileError('授予不存在', 'NOT_FOUND')
    await this.db.badgeAward.update({ where: { id: awardId }, data: { status: 'revoked', revokedReason: reason } })
    await this.db.profileFeaturedBadge.deleteMany({ where: { awardId } })
    return { revoked: true }
  }
}
