import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 集成测试环境：使用独立测试库 acm_club_test（真实 PostgreSQL）。
 * 首次运行自动创建库并应用迁移；测试之间按文件隔离（每文件 beforeAll 清库重种最小数据）。
 */

const PG_BIN = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin'
const TEST_DB = 'acm_club_test'
const TEST_URL = `postgresql://acm@127.0.0.1:5433/${TEST_DB}`

// 测试进程显式启用本地模拟；不读取用户真实认证模式，也不改写根 .env。
process.env.NODE_ENV = 'test'
process.env.AUTH_DEV_SIMULATOR = 'true'
process.env.AUTH_DEV_SIMULATOR_PASSWORD = 'integration-test-only'
process.env.PUBLIC_BASE_URL = 'http://localhost:5173'
delete process.env.CAS_VALIDATE_ADDRESS

function psql(sql: string, db = 'postgres'): void {
  execFileSync(path.join(PG_BIN, 'psql'), ['-h', '127.0.0.1', '-p', '5433', '-U', 'acm', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' })
}

export function ensureTestDatabase(): string {
  // .env 存在则加载必要变量（DATABASE_URL 由测试直接给定 TEST_URL）
  const envPath = path.resolve(process.cwd(), '../../.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m && m[1] !== 'CAS_VALIDATE_ADDRESS' && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  }
  // 每次重建测试库：避免脏状态/失败迁移残留（开发机本地专用库）
  psql(`DROP DATABASE IF EXISTS ${TEST_DB}`)
  psql(`CREATE DATABASE ${TEST_DB}`)
  psql(`ALTER DATABASE ${TEST_DB} SET timezone TO 'UTC'`, TEST_DB)
  // 应用全部迁移（prisma migrate deploy 在 packages/db 下执行）
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(process.cwd(), '../../packages/db'),
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
  })
  return TEST_URL
}

export { TEST_URL }
