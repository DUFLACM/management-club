import { Global, Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@acm/db'
import { loadEnv } from '../../config/env.js'

/**
 * 全局 Prisma 服务。
 * 普通数据访问走 Prisma；报名名额、签到检查点、积分入账、任务领取等
 * 事务/行锁场景使用 $transaction 与参数化 SQL（见各服务）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(connectionString?: string) {
    super(connectionString ?? loadEnv().DATABASE_URL)
  }
  async onModuleInit(): Promise<void> {
    await this.$connect()
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}

/**
 * 启动时检查新增功能依赖的表是否已迁移。
 * 只做提示，不阻断启动：旧库升级时公告等功能由迁移补齐，API/Worker 其余能力不受影响。
 * 结果缓存为状态位，避免迁移缺失时每个请求都打到数据库并刷错误日志。
 */
@Injectable()
export class SchemaStateService implements OnApplicationBootstrap {
  announcementsReady = true
  notificationsReady = true
  wxpusherReady = true

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await this.db.$queryRaw<Array<{ announcements: boolean; notifications: boolean; wxpusher: boolean }>>`
        SELECT
          to_regclass('public.announcements') IS NOT NULL AS announcements,
          to_regclass('public.user_notifications') IS NOT NULL AS notifications,
          (to_regclass('public.user_wxpusher_bindings') IS NOT NULL AND to_regclass('public.wxpusher_bind_tokens') IS NOT NULL) AS wxpusher
      `
      this.announcementsReady = rows[0]?.announcements !== false
      this.notificationsReady = rows[0]?.notifications !== false
      this.wxpusherReady = rows[0]?.wxpusher !== false
      if (!this.announcementsReady) {
        // eslint-disable-next-line no-console
        console.error(
          '[schema] 数据库缺少 announcements 表：公告接口不可用，成员端公告查询会返回空列表。' +
            '请在服务器仓库执行 `pnpm db:migrate:deploy` 后重启 API（勿只重启进程）。',
        )
      }
      if (!this.notificationsReady) {
        // eslint-disable-next-line no-console
        console.error(
          '[schema] 数据库缺少 user_notifications 表：个人通知将降级为空列表。' +
            '请执行 `pnpm db:migrate:deploy` 后重启 API。',
        )
      }
      if (!this.wxpusherReady) {
        // eslint-disable-next-line no-console
        console.error(
          '[schema] 数据库缺少 WxPusher 绑定表：微信推送绑定与异步下发将降级关闭。' +
            '请执行 `pnpm db:migrate:deploy` 后重启 API。',
        )
      }
    } catch (error) {
      // 数据库暂时不可用时由 Prisma 的常规连接错误处理；这里不吞掉真实故障
      // eslint-disable-next-line no-console
      console.error('[schema] 无法检查数据库迁移状态：', error instanceof Error ? error.message : error)
    }
  }
}

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: () => new PrismaService() },
    SchemaStateService,
  ],
  exports: [PrismaService, SchemaStateService],
})
export class DatabaseModule {}
