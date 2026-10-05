import { z } from 'zod'

/** 类型化环境配置（.env.example 一一对应；production 禁用模拟认证） */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 开发/测试默认本地实例；production 必须显式注入（下方校验）
  DATABASE_URL: z.string().min(1).default('postgresql://acm@127.0.0.1:5433/acm_club'),
  API_PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

  CAS_BASE_URL: z.string().url().default('https://cas.dlufl.edu.cn'),
  CAS_LOGIN_PATH: z.string().default('/cas/login'),
  CAS_VALIDATE_PATH: z.string().default('/cas/proxyValidate'),
  CAS_LOGOUT_PATH: z.string().default('/cas/logout'),
  CAS_STUDENT_NO_ATTRIBUTE: z.string().default('id_number'),
  CAS_REAL_NAME_ATTRIBUTE: z.string().default('user_name'),
  CAS_STABLE_SUBJECT_ATTRIBUTE: z.string().default('user_id'),
  // 可选公网解析固定值：用于代理 fake-IP 环境；TLS 仍校验 CAS_BASE_URL 的主机名。
  CAS_VALIDATE_ADDRESS: z.preprocess((value) => value === '' ? undefined : value, z.union([z.ipv4(), z.ipv6()]).optional()),
  CAS_ALLOWED_ID_TYPES: z.string().default(''),

  AUTH_DEV_SIMULATOR: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  AUTH_DEV_SIMULATOR_PASSWORD: z.string().optional(),

  SESSION_TTL_HOURS: z.coerce.number().default(168),
  SESSION_IDLE_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_NAME: z.string().default('club_session'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  CSRF_TTL_MINUTES: z.coerce.number().default(30),

  PLATFORM_ATCODER_PROBLEMS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  OUTBOUND_MIN_INTERVAL_MS: z.coerce.number().default(2100),
  OUTBOUND_TIMEOUT_MS: z.coerce.number().default(15000),
  OUTBOUND_MAX_JSON_BYTES: z.coerce.number().default(1048576),
  OUTBOUND_MAX_STANDINGS_BYTES: z.coerce.number().default(16777216),

  HYDRO_CONNECTOR_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
})

export type AppEnv = z.infer<typeof envSchema>

let cached: AppEnv | null = null

export function loadEnv(): AppEnv {
  if (cached) return cached
  if (process.env.NODE_ENV === 'production' && (!process.env.DATABASE_URL || !process.env.PUBLIC_BASE_URL)) {
    throw new Error('DATABASE_URL and PUBLIC_BASE_URL are required in production')
  }
  cached = envSchema.parse(process.env)
  if (cached.NODE_ENV === 'production' && cached.AUTH_DEV_SIMULATOR) {
    // 生产强制禁用模拟认证：宁可启动失败也不静默放行
    throw new Error('AUTH_DEV_SIMULATOR must be false in production')
  }
  return cached
}

/** 是否处于 CAS 模拟模式（启动日志与页面都会标记） */
export function isDevSimulatorEnabled(env: AppEnv): boolean {
  return env.AUTH_DEV_SIMULATOR && env.NODE_ENV !== 'production'
}
