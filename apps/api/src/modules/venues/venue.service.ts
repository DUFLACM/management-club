import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, sha256Hex } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { z } from 'zod'

/**
 * 地点管理与认证（09 方案）：
 * - venues（稳定地点 + active/suspended/archived）与 venue_versions（draft/pending_review/approved/rejected）分离。
 * - 创建/编辑/提交者按 principal 完整回避（venue_version_contributors）；换人提交不能绕过。
 * - 样本仅 draft 可追加；提交冻结证据清单与内容 hash。
 * - approved 版本不可变；修改建新版本；撤销/有效期独立字段。
 * - 新草稿不移动已发布活动围栏。
 */

export class VenueError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

export const venueDraftSchema = z.object({
  name: z.string().min(1).max(80),
  campus: z.string().max(40).optional(),
  building: z.string().max(40).optional(),
  floor: z.string().max(20).optional(),
  room: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
  directions: z.string().max(500).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  radiusMeters: z.number().min(5).max(2000).nullable().optional(),
  maxAccuracyMeters: z.number().min(5).max(200).nullable().optional(),
  coordinateSource: z.enum(['map_pick', 'field_sampling', 'manual_verified']).nullable().optional(),
  allowedCapabilities: z.array(z.enum(['GEO', 'QR'])).min(1).max(2),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
})

export type VenueDraftInput = z.infer<typeof venueDraftSchema>

export const sampleSchema = z.object({
  source: z.enum(['browser_geolocation', 'manual_note', 'device_check']),
  sampledAt: z.string().datetime(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracyMeters: z.number().min(0).max(500).nullable().optional(),
  deviceType: z.string().max(60).optional(),
  note: z.string().max(300).optional(),
})

function versionContentHash(input: VenueDraftInput, sampleDigest: string): string {
  return sha256Hex(JSON.stringify({ input, sampleDigest }))
}

@Injectable()
export class VenueService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 创建稳定地点 + 初始 draft 版本（不直接认证） */
  async createVenue(actor: SessionActor, input: VenueDraftInput): Promise<{ venueId: string; versionId: string }> {
    this.assertGeoCapabilityConsistency(input)
    const venueId = newId()
    const versionId = newId()
    await this.db.$transaction(async (tx) => {
      await tx.venue.create({
        data: {
          id: venueId,
          name: input.name,
          campus: input.campus,
          building: input.building,
          floor: input.floor,
          room: input.room,
          description: input.description,
          directions: input.directions,
          operationalStatus: 'active',
          createdBy: actor.principalId,
        },
      })
      await tx.venueVersion.create({
        data: {
          id: versionId,
          venueId,
          versionNo: 1,
          status: 'draft',
          name: input.name,
          campus: input.campus,
          building: input.building,
          floor: input.floor,
          room: input.room,
          description: input.description,
          directions: input.directions,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          radiusMeters: input.radiusMeters ?? null,
          maxAccuracyMeters: input.maxAccuracyMeters ?? null,
          coordinateSource: input.coordinateSource ?? null,
          allowedCapabilities: input.allowedCapabilities,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
        },
      })
      await tx.venueVersionContributor.create({
        data: { id: newId(), versionId, principalId: actor.principalId, role: 'creator' },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'venue.create',
          resourceType: 'venue',
          resourceId: venueId,
          summary: `创建地点 ${input.name}（draft v1）`,
        },
      })
    })
    return { venueId, versionId }
  }

  /** 仅 draft 可编辑；记录实际编辑者进回避集合 */
  async updateDraft(actor: SessionActor, venueId: string, versionId: string, expectedRevision: number, input: VenueDraftInput): Promise<void> {
    this.assertGeoCapabilityConsistency(input)
    await this.db.$transaction(async (tx) => {
      const version = await tx.venueVersion.findUnique({ where: { id: versionId } })
      if (!version || version.venueId !== venueId) throw new VenueError('版本不存在', 'NOT_FOUND')
      if (version.status !== 'draft') throw new VenueError('仅草稿可编辑；已提交/已认证版本不可变，请创建新版本', 'NOT_DRAFT')
      if (version.revision !== expectedRevision) throw new VenueError('版本已被他人修改，请刷新后重试', 'REVISION_CONFLICT')
      await tx.venueVersion.update({
        where: { id: versionId },
        data: {
          name: input.name,
          campus: input.campus,
          building: input.building,
          floor: input.floor,
          room: input.room,
          description: input.description,
          directions: input.directions,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          radiusMeters: input.radiusMeters ?? null,
          maxAccuracyMeters: input.maxAccuracyMeters ?? null,
          coordinateSource: input.coordinateSource ?? null,
          allowedCapabilities: input.allowedCapabilities,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
          revision: { increment: 1 },
        },
      })
      await tx.venueVersionContributor.upsert({
        where: { versionId_principalId: { versionId, principalId: actor.principalId } },
        create: { id: newId(), versionId, principalId: actor.principalId, role: 'editor', lastAt: new Date() },
        update: { role: 'editor', lastAt: new Date() },
      })
    })
  }

  /** 现场样本：仅 draft 可追加（提交后冻结证据清单） */
  async addSample(actor: SessionActor, venueId: string, versionId: string, input: z.infer<typeof sampleSchema>): Promise<void> {
    const version = await this.db.venueVersion.findUnique({ where: { id: versionId } })
    if (!version || version.venueId !== venueId) throw new VenueError('版本不存在', 'NOT_FOUND')
    if (version.status !== 'draft') {
      throw new VenueError('样本仅在草稿期可追加；提交后证据清单已冻结，补材料请新建版本', 'FROZEN')
    }
    await this.db.venueVerificationSample.create({
      data: {
        id: newId(),
        versionId,
        source: input.source,
        sampledAt: new Date(input.sampledAt),
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        accuracyMeters: input.accuracyMeters ?? null,
        deviceType: input.deviceType,
        note: input.note,
        contentHash: sha256Hex(JSON.stringify(input)),
      },
    })
  }

  /** 提交认证：校验、冻结证据清单/内容 hash、登记提交者回避 */
  async submitForReview(actor: SessionActor, venueId: string, versionId: string, expectedRevision: number): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const version = await tx.venueVersion.findUnique({ where: { id: versionId }, include: { samples: true } })
      if (!version || version.venueId !== venueId) throw new VenueError('版本不存在', 'NOT_FOUND')
      if (version.status !== 'draft') throw new VenueError('仅草稿可提交', 'NOT_DRAFT')
      if (version.revision !== expectedRevision) throw new VenueError('版本已变更，请刷新', 'REVISION_CONFLICT')
      // QR_ONLY 可无坐标；声明 GEO 能力则必须有坐标/半径/精度
      if (version.allowedCapabilities.includes('GEO')) {
        if (version.latitude == null || version.longitude == null || version.radiusMeters == null || version.maxAccuracyMeters == null) {
          throw new VenueError('声明 GEO 能力必须提供 WGS84 坐标、半径与精度阈值（不得虚构坐标）', 'GEO_INCOMPLETE')
        }
      }
      const draftInput: VenueDraftInput = {
        name: version.name,
        campus: version.campus ?? undefined,
        building: version.building ?? undefined,
        floor: version.floor ?? undefined,
        room: version.room ?? undefined,
        description: version.description ?? undefined,
        directions: version.directions ?? undefined,
        latitude: version.latitude ? Number(version.latitude) : null,
        longitude: version.longitude ? Number(version.longitude) : null,
        radiusMeters: version.radiusMeters ? Number(version.radiusMeters) : null,
        maxAccuracyMeters: version.maxAccuracyMeters ? Number(version.maxAccuracyMeters) : null,
        coordinateSource: (version.coordinateSource as VenueDraftInput['coordinateSource']) ?? null,
        allowedCapabilities: version.allowedCapabilities as VenueDraftInput['allowedCapabilities'],
        validFrom: version.validFrom?.toISOString() ?? null,
        validUntil: version.validUntil?.toISOString() ?? null,
      }
      const sampleDigest = sha256Hex(version.samples.map((s) => s.contentHash ?? '').sort().join(','))
      const contentHash = versionContentHash(draftInput, sampleDigest)
      await tx.venueVersion.update({
        where: { id: versionId },
        data: {
          status: 'pending_review',
          submittedBy: actor.principalId,
          submittedAt: new Date(),
          contentHash,
          evidenceDigest: sampleDigest,
        },
      })
      await tx.venueVersionContributor.upsert({
        where: { versionId_principalId: { versionId, principalId: actor.principalId } },
        create: { id: newId(), versionId, principalId: actor.principalId, role: 'submitter' },
        update: { role: 'submitter', lastAt: new Date() },
      })
      await tx.venueReviewEvent.create({
        data: {
          id: newId(),
          versionId,
          principalId: actor.principalId,
          action: 'submit',
          reason: '提交认证申请',
          contentHash,
        },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'venue.submit',
          resourceType: 'venue_version',
          resourceId: versionId,
          summary: `提交地点版本认证（venue ${venueId}）`,
        },
      })
    })
  }

  /**
   * 独立审核：创建/编辑/提交者全部回避（principal_id 比对，换人提交不能绕过）。
   * approve/reject 并发只有一个有效结论；重复通过返回原结果。
   */
  async decide(actor: SessionActor, venueId: string, versionId: string, decision: 'approve' | 'reject', reason: string, expectedContentHash?: string): Promise<void> {
    if (!reason.trim()) throw new VenueError('审核必须填写结论与理由', 'REASON_REQUIRED')
    await this.db.$transaction(async (tx) => {
      const version = await tx.venueVersion.findUnique({
        where: { id: versionId },
        include: { contributors: true },
      })
      if (!version || version.venueId !== venueId) throw new VenueError('版本不存在', 'NOT_FOUND')
      if (version.status === 'approved' && decision === 'approve') return // 幂等
      if (version.status !== 'pending_review') {
        throw new VenueError(`当前状态 ${version.status} 不可审核`, 'STATE_INVALID')
      }
      if (expectedContentHash && version.contentHash !== expectedContentHash) {
        throw new VenueError('内容已变化，请刷新后审核', 'CONTENT_CHANGED')
      }
      // 完整回避：创建者/编辑者/提交者均不得审核
      if (version.contributors.some((c) => c.principalId === actor.principalId)) {
        throw new VenueError('你是本版本的创建/编辑/提交者，必须回避审核', 'RECUSED')
      }
      const now = new Date()
      if (decision === 'approve') {
        await tx.venueVersion.update({
          where: { id: versionId },
          data: { status: 'approved', approvedBy: actor.principalId, approvedAt: now },
        })
        // effective_version_id 指向最新批准版本（不移动旧活动围栏——活动绑定的是具体 version_id）
        await tx.venue.update({
          where: { id: venueId },
          data: { effectiveVersionId: versionId, revision: { increment: 1 } },
        })
      } else {
        await tx.venueVersion.update({
          where: { id: versionId },
          data: { status: 'rejected', rejectedReason: reason },
        })
      }
      await tx.venueReviewEvent.create({
        data: {
          id: newId(),
          versionId,
          principalId: actor.principalId,
          action: decision,
          reason,
          contentHash: version.contentHash,
        },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: `venue.${decision}`,
          resourceType: 'venue_version',
          resourceId: versionId,
          summary: `地点版本${decision === 'approve' ? '批准' : '驳回'}：${reason.slice(0, 200)}`,
        },
      })
    })
  }

  /** 撤销认证：不篡改 approved 历史结论；撤销后即时阻止自动核验 */
  async revoke(actor: SessionActor, venueId: string, versionId: string, reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const version = await tx.venueVersion.findUnique({ where: { id: versionId } })
      if (!version || version.venueId !== venueId) throw new VenueError('版本不存在', 'NOT_FOUND')
      if (version.status !== 'approved') throw new VenueError('仅已认证版本可撤销', 'STATE_INVALID')
      await tx.venueVersion.update({
        where: { id: versionId },
        data: { revokedAt: new Date(), revokedReason: reason },
      })
      await tx.venueReviewEvent.create({
        data: { id: newId(), versionId, principalId: actor.principalId, action: 'revoke', reason, contentHash: version.contentHash },
      })
      // 撤销相关未到期 QR（停用撤销 QR，恢复不复活旧码）
      await tx.attendanceQrWindow.updateMany({
        where: { venueVersionId: versionId, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'venue.revoke',
          resourceType: 'venue_version',
          resourceId: versionId,
          summary: `撤销认证：${reason.slice(0, 200)}`,
        },
      })
    })
  }

  /** 从已有版本创建新 draft（修订/更新；不改旧活动） */
  async newDraftFromVersion(actor: SessionActor, venueId: string, baseVersionId: string, input: VenueDraftInput): Promise<{ versionId: string }> {
    this.assertGeoCapabilityConsistency(input)
    const versionId = newId()
    await this.db.$transaction(async (tx) => {
      const venue = await tx.venue.findUnique({ where: { id: venueId }, include: { versions: { select: { versionNo: true } } } })
      if (!venue) throw new VenueError('地点不存在', 'NOT_FOUND')
      const base = await tx.venueVersion.findUnique({ where: { id: baseVersionId } })
      if (!base || base.venueId !== venueId) throw new VenueError('基准版本不存在', 'NOT_FOUND')
      const nextNo = Math.max(...venue.versions.map((v) => v.versionNo), base.versionNo) + 1
      await tx.venueVersion.create({
        data: {
          id: versionId,
          venueId,
          versionNo: nextNo,
          status: 'draft',
          name: input.name,
          campus: input.campus,
          building: input.building,
          floor: input.floor,
          room: input.room,
          description: input.description,
          directions: input.directions,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          radiusMeters: input.radiusMeters ?? null,
          maxAccuracyMeters: input.maxAccuracyMeters ?? null,
          coordinateSource: input.coordinateSource ?? null,
          allowedCapabilities: input.allowedCapabilities,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
        },
      })
      await tx.venueVersionContributor.create({
        data: { id: newId(), versionId, principalId: actor.principalId, role: 'creator' },
      })
    })
    return { versionId }
  }

  /** 运行状态：暂停/恢复/归档（venue.suspend 权限）；暂停即时阻止新自动签到 */
  async setOperationalStatus(actor: SessionActor, venueId: string, status: 'active' | 'suspended' | 'archived', reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const venue = await tx.venue.findUnique({ where: { id: venueId }, include: { versions: { where: { status: 'approved' } } } })
      if (!venue) throw new VenueError('地点不存在', 'NOT_FOUND')
      if (status === 'active' && !venue.versions.some((v) => v.revokedAt == null && (v.validUntil == null || v.validUntil > new Date()))) {
        throw new VenueError('恢复要求仍存在有效已认证版本；围栏/房间变化请走新版本审核', 'NO_VALID_VERSION')
      }
      // 串行化：对 venue 行加锁，与签到/发布事务的 FOR SHARE 读并发协调
      await tx.$executeRaw`SELECT id FROM venues WHERE id = ${venueId}::uuid FOR UPDATE`
      await tx.venue.update({
        where: { id: venueId },
        data: { operationalStatus: status, suspendReason: status === 'active' ? null : reason, revision: { increment: 1 } },
      })
      if (status !== 'active') {
        // 撤销未到期现场码（通过该地点版本绑定的）
        await tx.$executeRaw`
          UPDATE attendance_qr_windows w SET revoked_at = now()
          FROM venue_versions vv
          WHERE vv.venue_id = ${venueId}::uuid AND vv.id = w.venue_version_id
            AND w.revoked_at IS NULL AND w.expires_at > now()`
      }
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: `venue.${status}`,
          resourceType: 'venue',
          resourceId: venueId,
          summary: `运行状态 → ${status}：${reason.slice(0, 200)}`,
        },
      })
    })
  }

  /** 发布用校验：版本 approved、未撤销、有效期覆盖窗口、具备所需能力、地点 active */
  async assertVersionPublishable(versionId: string, requiredCapabilities: string[], windowStart: Date, windowEnd: Date): Promise<void> {
    const version = await this.db.venueVersion.findUnique({ where: { id: versionId }, include: { venue: true } })
    if (!version) throw new VenueError('地点版本不存在', 'NOT_FOUND')
    if (version.status !== 'approved' || version.revokedAt != null) {
      throw new VenueError('地点版本未认证或已撤销，正式发布只能绑定已认证版本', 'VENUE_NOT_VERIFIED')
    }
    if (version.venue.operationalStatus !== 'active') {
      throw new VenueError('地点已停用/归档', 'VENUE_SUSPENDED')
    }
    if (version.validFrom && version.validFrom > windowStart) {
      throw new VenueError('地点认证有效期未覆盖签到窗口开始', 'VENUE_WINDOW_NOT_COVERED')
    }
    if (version.validUntil && version.validUntil < windowEnd) {
      throw new VenueError('地点认证有效期未覆盖签退窗口结束', 'VENUE_WINDOW_NOT_COVERED')
    }
    for (const cap of requiredCapabilities) {
      if (!version.allowedCapabilities.includes(cap)) {
        throw new VenueError(`地点版本未认证 ${cap} 能力`, 'CAPABILITY_MISSING')
      }
    }
  }

  /** 停用/变更影响预览（不改变数据） */
  async impactPreview(venueId: string): Promise<{
    activeVersionCount: number
    futureActivities: Array<{ id: string; title: string; startAt: Date; status: string }>
    activeQrWindows: number
  }> {
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      include: {
        versions: { where: { status: 'approved', revokedAt: null }, select: { id: true } },
      },
    })
    if (!venue) throw new VenueError('地点不存在', 'NOT_FOUND')
    const versionIds = venue.versions.map((v) => v.id)
    const bindings = await this.db.activityVenueBinding.findMany({
      where: { venueVersionId: { in: versionIds }, activity: { status: 'published', startAt: { gte: new Date() } } },
      include: { activity: { select: { id: true, title: true, startAt: true, status: true } } },
    })
    const qrCount = await this.db.attendanceQrWindow.count({
      where: { venueVersionId: { in: versionIds }, revokedAt: null, expiresAt: { gt: new Date() } },
    })
    return {
      activeVersionCount: versionIds.length,
      futureActivities: bindings.map((b) => b.activity),
      activeQrWindows: qrCount,
    }
  }

  private assertGeoCapabilityConsistency(input: VenueDraftInput): void {
    if (input.allowedCapabilities.includes('GEO')) {
      if (input.latitude == null || input.longitude == null) {
        throw new VenueError('声明 GEO 能力必须有实测 WGS84 坐标；纯二维码地点请只声明 QR', 'GEO_NEEDS_COORDS')
      }
      if (input.radiusMeters == null || input.maxAccuracyMeters == null) {
        throw new VenueError('GEO 能力必须配置围栏半径与允许精度', 'GEO_NEEDS_FENCE')
      }
    }
    if (input.latitude != null && input.longitude == null) throw new VenueError('经纬度必须成对', 'COORDS_PAIR')
    if (input.latitude == null && input.longitude != null) throw new VenueError('经纬度必须成对', 'COORDS_PAIR')
    if (input.validFrom && input.validUntil && new Date(input.validFrom) >= new Date(input.validUntil)) {
      throw new VenueError('有效区间起止顺序不正确', 'VALIDITY_ORDER')
    }
  }
}
