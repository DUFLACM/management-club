import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient as PrismaClientBase } from './generated/client/client.js'

export { PrismaClient as PrismaClientBase } from './generated/client/client.js'
export * from './generated/client/client.js'
export { loadRuntimeEnvironment } from './runtime-env.js'
export { attendanceDeadline, applyAutoCheckout, settleRequiredAbsences } from './required-attendance.js'

/**
 * 创建 PrismaClient（Prisma 7 驱动适配器模式，无 Rust 引擎）。
 * API 与 Worker 各自进程持有一个实例；连接串由环境注入。
 * 注意：PrismaClient 此处导出为值（运行时类），供 PrismaService 继承。
 */
export class PrismaClient extends PrismaClientBase {
  constructor(connectionString: string) {
    const adapter = new PrismaPg({ connectionString })
    super({ adapter, log: process.env.PRISMA_LOG === 'query' ? ['error', 'warn'] : ['error'] })
  }
}

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient(connectionString)
}
