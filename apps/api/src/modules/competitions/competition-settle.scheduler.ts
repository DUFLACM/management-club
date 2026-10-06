import { Inject, Injectable, OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { CompetitionEventService } from './competition-event.service.js'

/**
 * 正式赛事（platform_auto）结算调度器，镜像 scoring/contest-settle.scheduler.ts 的扫描风格：
 * - 每 5 分钟扫描已结束超过 5 分钟处理窗口（7 天内）、尚未结算的 platform_auto 赛事；
 * - 已结算（status=settled）的跳过；管理端「结算积分」按钮可强制重跑（入账幂等）。
 */
@Injectable()
export class CompetitionSettleScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(CompetitionEventService) private readonly events: CompetitionEventService,
  ) {}

  onModuleInit(): void {
    const tick = async () => {
      try {
        const candidates = await this.db.competitionEvent.findMany({
          where: {
            scoringMode: 'platform_auto',
            status: { not: 'settled' },
            platform: { not: null },
            platformContestId: { not: null },
            endAt: { gt: new Date(Date.now() - 7 * 24 * 3600_000), lt: new Date(Date.now() - 5 * 60_000) },
          },
          select: { id: true },
          take: 20,
        })
        for (const event of candidates) {
          try {
            const result = await this.events.settleEvent(null, event.id)
            // eslint-disable-next-line no-console
            console.log(`[competition-settle-scheduler] ${event.id} 自动结算：入账 ${result.posted} 笔`)
          } catch {
            // 榜单不可用/窗口内等：下个扫描周期重试
          }
        }
      } catch {
        // 调度失败不影响 HTTP 服务
      }
    }
    this.timer = setInterval(() => void tick(), 5 * 60_000)
    setTimeout(() => void tick(), 90_000)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
