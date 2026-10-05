import { Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/database.module.js'
import { newId, sha256Hex } from '../../common/utils.js'

/**
 * 审计日志：actor/action/resource/理由/前后摘要。
 * 不记录 ticket、session token、邀请码明文、QR token 与精确定位原文。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async log(entry: {
    actorPrincipalId?: string | null
    action: string
    resourceType: string
    resourceId: string
    summary?: string
    before?: unknown
    after?: unknown
    reason?: string
  }): Promise<void> {
    await this.db.auditLog.create({
      data: {
        id: newId(),
        actorPrincipalId: entry.actorPrincipalId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        summary: entry.summary?.slice(0, 2000),
        beforeDigest: entry.before == null ? null : sha256Hex(JSON.stringify(entry.before)).slice(0, 64),
        afterDigest: entry.after == null ? null : sha256Hex(JSON.stringify(entry.after)).slice(0, 64),
        reason: entry.reason,
      },
    })
  }
}
