import { Inject, Injectable, OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { ScoringService } from './scoring.service.js'

/**
 * 平台赛结算调度器（API 进程内轻量循环）：
 * - 每 5 分钟扫描一次：已发布 + 关联平台 + 结束超过 5 分钟处理窗口（7 天内）的活动；
 * - 已入账过该场 W 分的活动直接跳过（不重复抓取平台榜单，控制外呼频率）；
 * - 管理端「结算比赛积分」按钮可强制重跑（入账幂等，不会重复计分）；
 * - 榜单抓取本身有 60 秒缓存与主机级限流，叠加本调度器的扫描间隔与跳过逻辑控频。
 */
@Injectable()
export class ContestSettleScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ScoringService) private readonly scoring: ScoringService,
  ) {}

  onModuleInit(): void {
    const tick = async () => {
      try {
        const candidates = await this.db.activity.findMany({
          where: {
            status: 'published',
            platform: { not: null },
            platformContestId: { not: null },
            endAt: { gt: new Date(Date.now() - 7 * 24 * 3600_000), lt: new Date(Date.now() - 5 * 60_000) },
          },
          select: { id: true, platform: true, platformContestId: true },
          take: 20,
        })
        for (const activity of candidates) {
          const settled = await this.db.pointsLedgerEntry.findFirst({
            where: { sourceKey: { startsWith: `contest:${activity.platform}:${activity.platformContestId}:W:` }, status: 'approved' },
            select: { id: true },
          })
          if (settled) continue
          try {
            const result = await this.scoring.settleContestScores(null, activity.id)
            // eslint-disable-next-line no-console
            console.log(`[settle-scheduler] ${activity.id} 自动结算：入账 ${result.posted} 笔（λ=${result.lambda.key}/${result.lambda.source}）`)
          } catch {
            // 榜单不可用/窗口内等：下个扫描周期重试
          }
        }
      } catch {
        // 调度失败不影响 HTTP 服务
      }
    }
    // 启动后延迟 1 分钟再开始，避免与启动流量重叠
    this.timer = setInterval(() => void tick(), 5 * 60_000)
    setTimeout(() => void tick(), 60_000)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
