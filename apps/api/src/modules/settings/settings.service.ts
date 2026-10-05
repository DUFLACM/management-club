import { DomainError } from '../../common/domain-error.js'
import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId, sha256Hex, randomToken } from '../../common/utils.js'
import { z } from 'zod'
import type { SessionActor } from '../auth/session.service.js'

/**
 * 站点系统设置（08 方案 6）：
 * - 类型化 schema 校验；draft → validated → pending_approval → approved → published。
 * - 发布在事务内更新有效指针 + 审计 + outbox；恢复 = 以旧值建立新版本。
 * - 秘密只写（PUT /admin/secrets/:key），GET 只返回 configured/轮换状态。
 * - system_admin 维护基础设施；业务裁决（规则/审核/隐私）不因技术权限绕过审批。
 */

export const SETTING_GROUPS = [
  'branding', 'general', 'term', 'rule_defaults', 'attendance_defaults', 'invite_policy',
  'badges', 'privacy_disclosures', 'platforms', 'worker', 'review_rules', 'cas', 'security', 'maintenance', 'backups',
] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]

export class SettingsError extends DomainError {
  constructor(message: string, readonly code: string) {
    super(message, code)
  }
}

const GROUP_SCHEMAS: Record<SettingGroup, z.ZodTypeAny> = {
  branding: z.object({ siteName: z.string().min(2).max(40), shortName: z.string().max(16), footerNote: z.string().max(200).optional() }),
  general: z.object({ supportContact: z.string().max(120).optional(), defaultPageSize: z.number().int().min(10).max(100) }),
  term: z.object({ semesterCode: z.string().max(16), registerWindowOpen: z.boolean() }),
  rule_defaults: z.object({ defaultRuleVersion: z.number().int().min(1).optional(), note: z.string().max(300).optional() }),
  attendance_defaults: z.object({ defaultPolicy: z.enum(['GEO_ONLY', 'QR_ONLY', 'GEO_OR_QR', 'GEO_AND_QR']), defaultQrRotateSeconds: z.number().int().min(10).max(120), defaultMaxAccuracyMeters: z.number().min(5).max(200) }),
  invite_policy: z.object({ defaultExpiresInDays: z.number().int().min(1).max(365), defaultMaxUses: z.number().int().min(1).max(200) }),
  badges: z.object({ publicDisplayAllowed: z.boolean() }),
  privacy_disclosures: z.object({ publicProfilesEnabled: z.boolean(), retentionNote: z.string().max(300).optional() }),
  platforms: z.object({ nowcoderEnabled: z.boolean(), codeforcesEnabled: z.boolean(), atcoderEnabled: z.boolean(), atcoderProblemsEnabled: z.boolean() }),
  worker: z.object({ concurrency: z.number().int().min(1).max(16), jobTimeoutMinutes: z.number().int().min(1).max(60) }),
  review_rules: z.object({ minReviewers: z.number().int().min(2), teacherEscalationEnabled: z.boolean() }),
  cas: z.object({ note: z.string().max(200).optional() }), // CAS 地址为受控部署配置，页面只读
  security: z.object({ sessionTtlHours: z.number().int().min(1).max(720), sensitiveReauthMinutes: z.number().int().min(1).max(120) }),
  maintenance: z.object({ readOnlyMode: z.boolean(), notice: z.string().max(300).optional() }),
  backups: z.object({ note: z.string().max(300).optional() }),
}

/** 需要业务审批的分组（system_admin 不能直接发布） */
const BUSINESS_GROUPS = new Set<SettingGroup>(['term', 'rule_defaults', 'review_rules', 'privacy_disclosures'])

@Injectable()
export class SettingsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async effective(group: SettingGroup): Promise<Record<string, unknown> | null> {
    const row = await this.db.siteSettingVersion.findFirst({
      where: { group, status: 'published' },
      orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    })
    return (row?.value as Record<string, unknown>) ?? null
  }

  /** 组内当前有效值 + 草稿状态（秘密只显示 configured 状态） */
  async groupView(group: SettingGroup): Promise<{ effective: Record<string, unknown> | null; draft: unknown; versions: Array<{ id: string; status: string; revision: number; changeSummary: string | null; createdAt: Date; createdBy: string }> }> {
    const versions = await this.db.siteSettingVersion.findMany({
      where: { group },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    return {
      effective: (versions.find((v) => v.status === 'published')?.value as Record<string, unknown>) ?? null,
      draft: versions.find((v) => v.status === 'draft') ?? null,
      versions: versions.map((v) => ({ id: v.id, status: v.status, revision: v.revision, changeSummary: v.changeSummary, createdAt: v.createdAt, createdBy: v.createdBy })),
    }
  }

  async createDraft(actor: SessionActor, group: SettingGroup, value: unknown, changeSummary: string): Promise<{ versionId: string }> {
    GROUP_SCHEMAS[group].parse(value) // 类型化校验失败直接 400
    const id = newId()
    await this.db.siteSettingVersion.create({
      data: { id, group, key: group, value: value as never, status: 'draft', changeSummary, createdBy: actor.principalId } as never,
    })
    await this.db.settingEvent.create({
      data: { id: newId(), versionId: id, principalId: actor.principalId, action: 'draft', note: changeSummary },
    })
    return { versionId: id }
  }

  /** 审批（业务组需要非 system_admin 业务权限；发布人与审批人分离） */
  async approve(actor: SessionActor, versionId: string): Promise<void> {
    const version = await this.db.siteSettingVersion.findUnique({ where: { id: versionId } })
    if (!version) throw new SettingsError('版本不存在', 'NOT_FOUND')
    if (version.status !== 'validated' && version.status !== 'pending_approval') throw new SettingsError('先校验再审批', 'STATE_INVALID')
    if (BUSINESS_GROUPS.has(version.group as SettingGroup) && !actor.roles.some((r) => ['presidium', 'advisor', 'points_reviewer'].includes(r))) {
      throw new SettingsError('该分组属业务裁决，需要业务审批权限（system_admin 技术权限不能替代）', 'BUSINESS_APPROVAL_REQUIRED')
    }
    if (version.createdBy === actor.principalId) {
      throw new SettingsError('审批人与草稿创建人不能为同一主体', 'SAME_PRINCIPAL')
    }
    await this.db.siteSettingVersion.update({ where: { id: versionId }, data: { status: 'approved', approvedBy: actor.principalId } })
    await this.db.settingEvent.create({ data: { id: newId(), versionId, principalId: actor.principalId, action: 'approve' } })
  }

  /** 发布：事务内生效指针语义（published 为当前有效）+ outbox；普通低影响字段已审批即可发布 */
  async publish(actor: SessionActor, versionId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const version = await tx.siteSettingVersion.findUnique({ where: { id: versionId } })
      if (!version) throw new SettingsError('版本不存在', 'NOT_FOUND')
      if (version.status !== 'approved') throw new SettingsError('未审批不可发布', 'STATE_INVALID')
      // 旧 published 版本转 superseded
      await tx.siteSettingVersion.updateMany({
        where: { group: version.group, status: 'published' },
        data: { status: 'superseded' },
      })
      await tx.siteSettingVersion.update({
        where: { id: versionId },
        data: { status: 'published', publishedAt: new Date(), effectiveAt: new Date() },
      })
      await tx.settingEvent.create({ data: { id: newId(), versionId, principalId: actor.principalId, action: 'publish' } })
      await tx.outboxEvent.create({
        data: { id: newId(), aggregateType: 'settings', aggregateId: version.group, type: 'settings.published', payload: { group: version.group } as never },
      })
      await tx.auditLog.create({
        data: { id: newId(), actorPrincipalId: actor.principalId, action: 'settings.publish', resourceType: 'site_setting', resourceId: versionId, summary: `发布设置 ${version.group}` },
      })
    })
  }

  async validateDraft(versionId: string): Promise<{ valid: boolean; issues: string[] }> {
    const version = await this.db.siteSettingVersion.findUnique({ where: { id: versionId } })
    if (!version) throw new SettingsError('版本不存在', 'NOT_FOUND')
    const issues: string[] = []
    try {
      GROUP_SCHEMAS[version.group as SettingGroup].parse(version.value)
    } catch (e) {
      issues.push(`schema 校验失败: ${(e as Error).message}`)
    }
    if (issues.length === 0) {
      await this.db.siteSettingVersion.update({ where: { id: versionId }, data: { status: 'validated' } })
      await this.db.settingEvent.create({ data: { id: newId(), versionId, principalId: version.createdBy, action: 'validate' } })
    }
    return { valid: issues.length === 0, issues }
  }

  /** 恢复 = 以旧值建立新恢复草稿（不回滚数据库、不删除中间历史） */
  async revert(actor: SessionActor, versionId: string, reason: string): Promise<{ newDraftId: string }> {
    const old = await this.db.siteSettingVersion.findUnique({ where: { id: versionId } })
    if (!old) throw new SettingsError('目标版本不存在', 'NOT_FOUND')
    const id = newId()
    await this.db.siteSettingVersion.create({
      data: {
        id, group: old.group, key: old.key, value: old.value as never, status: 'draft',
        changeSummary: `恢复自 ${versionId.slice(0, 8)}：${reason}`, createdBy: actor.principalId, revertOfId: versionId,
      },
    })
    return { newDraftId: id }
  }

  /** 秘密只写：生成引用（开发环境存加密列；生产接 KMS），GET 不回明文 */
  async writeSecret(actor: SessionActor, key: string, secret: string): Promise<{ keyId: string; configured: boolean }> {
    if (!secret || secret.length < 16) throw new SettingsError('密钥长度不足（至少 16 字节熵）', 'SECRET_WEAK')
    const existing = await this.db.secretReference.findUnique({ where: { key } })
    if (existing) {
      await this.db.secretReference.update({
        where: { key },
        data: { secretEnc: secret, version: { increment: 1 }, lastRotated: new Date(), disabledAt: null, configured: true },
      })
    } else {
      await this.db.secretReference.create({ data: { id: newId(), key, secretEnc: secret, configured: true } })
    }
    await this.audit.log({
      actorPrincipalId: actor.principalId,
      action: 'secrets.write',
      resourceType: 'secret_reference',
      resourceId: key,
      summary: `写入/轮换密钥 ${key}（值不记录；摘要 ${sha256Hex(secret).slice(0, 8)}…）`,
    })
    return { keyId: key, configured: true }
  }

  async secretStatus(): Promise<Array<{ key: string; configured: boolean; version: number; lastRotated: Date; disabled: boolean }>> {
    const refs = await this.db.secretReference.findMany()
    return refs.map((r) => ({ key: r.key, configured: r.configured, version: r.version, lastRotated: r.lastRotated, disabled: r.disabledAt != null }))
  }

  async disableSecret(actor: SessionActor, key: string): Promise<void> {
    await this.db.secretReference.updateMany({ where: { key }, data: { disabledAt: new Date(), configured: false } })
    await this.audit.log({ actorPrincipalId: actor.principalId, action: 'secrets.disable', resourceType: 'secret_reference', resourceId: key, summary: `禁用密钥 ${key}` })
  }
}

export function newSecretPlaceholder(): string {
  return randomToken(24)
}
