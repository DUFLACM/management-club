import fs from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { defineConfig, env } from 'prisma/config'
import { PrismaPg } from '@prisma/adapter-pg'

// Prisma 7 配置文件不自动加载仓库根 .env；从 cwd 向上查找（prisma 命令在 packages/db 下执行）。
function findEnvFile(): string | undefined {
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
const envFile = findEnvFile()
if (envFile) loadDotenv({ path: envFile })

const repoRoot = path.resolve(__dirname, '..', '..')

// schema 与迁移位于仓库根 prisma/（方案的统一位置），由本包统一执行。
export default defineConfig({
  schema: path.join(repoRoot, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(repoRoot, 'prisma', 'migrations'),
    seed: 'pnpm --filter @acm/db seed',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
  // 运行时通过 pg 驱动适配器连接（Prisma 7 无 Rust 引擎）
  adapter: async () => new PrismaPg({ connectionString: env('DATABASE_URL') }),
})
