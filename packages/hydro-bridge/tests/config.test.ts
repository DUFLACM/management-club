import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, validateConfig, webhookUrl, DEFAULT_ENDPOINT, type BridgeConfig } from '../src/config.js'

const BASE_ENV = {
  HYDROOJ_CLUB_INSTANCE_ID: '11111111-1111-4111-8111-111111111111',
  HYDROOJ_CLUB_ENDPOINT: 'https://club.example.edu.cn',
  HYDROOJ_CLUB_PUSH_SECRET: 'push-secret-0123456789abcdef0123456789abcdef',
  HYDROOJ_CLUB_PULL_SECRET: 'pull-secret-0123456789abcdef0123456789abcdef',
  HYDROOJ_CLUB_ALLOWED_DOMAINS: 'acm-club, training',
  HYDROOJ_CLUB_SERVICE_ACCOUNT_UID: '1001',
} as const

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {}
  const keys = new Set([...Object.keys(BASE_ENV), ...Object.keys(env)])
  for (const key of keys) backup[key] = process.env[key]
  for (const key of keys) {
    const value = key in env ? env[key] : (BASE_ENV as Record<string, string | undefined>)[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HYDROOJ_CLUB_')) delete process.env[key]
  }
})

describe('配置读取', () => {
  it('环境变量全量配置：默认 keyId、域列表去重去空、投递/刷新默认值', () => {
    withEnv({}, () => {
      const { config, issues } = loadConfig()
      expect(issues.errors).toEqual([])
      expect(config.instanceId).toBe(BASE_ENV.HYDROOJ_CLUB_INSTANCE_ID)
      expect(config.allowedDomains).toEqual(['acm-club', 'training'])
      expect(config.pushKeyId).toBe(`hydro:${config.instanceId}`)
      expect(config.pullKeyId).toBe(`hydro-pull:${config.instanceId}`)
      expect(config.delivery).toEqual({ intervalMs: 5_000, batchSize: 20, concurrency: 4, timeoutMs: 10_000 })
      expect(config.refresh).toEqual({ intervalMs: 15_000, batchSize: 50 })
    })
  })

  it('keyId/限流可覆盖；endpoint 去尾部斜杠', () => {
    withEnv({
      HYDROOJ_CLUB_ENDPOINT: 'https://club.example.edu.cn/',
      HYDROOJ_CLUB_PUSH_KEY_ID: 'key-2026-a',
      HYDROOJ_CLUB_PULL_KEY_ID: 'key-2026-b',
      HYDROOJ_CLUB_DELIVERY_TIMEOUT_MS: '8000',
    }, () => {
      const { config } = loadConfig()
      expect(config.endpoint).toBe('https://club.example.edu.cn')
      expect(config.pushKeyId).toBe('key-2026-a')
      expect(config.pullKeyId).toBe('key-2026-b')
      expect(config.delivery.timeoutMs).toBe(8_000)
    })
  })

  it('缺少关键配置时报 errors（插件应停用而非半运行）', () => {
    withEnv({
      HYDROOJ_CLUB_INSTANCE_ID: undefined,
      HYDROOJ_CLUB_PUSH_SECRET: 'short',
      HYDROOJ_CLUB_ALLOWED_DOMAINS: undefined,
    }, () => {
      const { issues } = loadConfig()
      expect(issues.errors.some((e) => e.includes('instanceId'))).toBe(true)
      expect(issues.errors.some((e) => e.includes('pushSecret'))).toBe(true)
      expect(issues.errors.some((e) => e.includes('allowedDomains'))).toBe(true)
    })
  })

  it('相同/回环 endpoint 与相同 secret 给出 warnings', () => {
    const config = {
      instanceId: BASE_ENV.HYDROOJ_CLUB_INSTANCE_ID,
      endpoint: DEFAULT_ENDPOINT,
      pushKeyId: 'k',
      pullKeyId: 'p',
      pushSecret: 'x'.repeat(40),
      pullSecret: 'x'.repeat(40),
      allowedDomains: ['acm-club'],
      serviceAccountUid: 1001,
      allowedContests: [],
      allowPrivateContests: false,
      delivery: { intervalMs: 5_000, batchSize: 20, concurrency: 4, timeoutMs: 10_000 },
      refresh: { intervalMs: 15_000, batchSize: 50 },
      sweepLookbackDays: 180,
      sweepIntervalMs: 21_600_000,
    } as BridgeConfig
    const issues = validateConfig(config)
    expect(issues.errors).toEqual([])
    expect(issues.warnings.some((w) => w.includes('club.example.edu.cn'))).toBe(true)
    expect(issues.warnings.some((w) => w.includes('不同 secret'))).toBe(true)
    const loopback = validateConfig({ ...config, endpoint: 'http://127.0.0.1:3000' })
    expect(loopback.warnings.some((w) => w.includes('回环'))).toBe(true)
  })

  it('webhook URL 固定拼接端点路径，不依提交内容变化', () => {
    withEnv({}, () => {
      const { config } = loadConfig()
      expect(webhookUrl(config)).toBe(`${BASE_ENV.HYDROOJ_CLUB_ENDPOINT}/api/v1/integrations/hydro/events`)
    })
  })
})
