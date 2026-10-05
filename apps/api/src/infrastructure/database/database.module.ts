import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
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

@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: () => new PrismaService() }],
  exports: [PrismaService],
})
export class DatabaseModule {}
