import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { deliverOnce, runDeliveryRound, type FetchLike } from '../src/delivery.js'
import { OutboxStore, type OutboxDoc, type ResourceDoc } from '../src/outbox.js'
import { loadConfig, webhookUrl } from '../src/config.js'
import { MockCollection } from './helpers/mock-collection.js'
import { sha256Hex } from '../src/contracts.js'
import { hydroCanonical, hydroSign } from '../src/contracts.js'

/** 构造测试配置（环境变量外的全量默认 + 固定 secret） */
function testConfig() {
  const env = {
    HYDROOJ_CLUB_INSTANCE_ID: '11111111-1111-4111-8111-111111111111',
    HYDROOJ_CLUB_ENDPOINT: 'https://club.example.edu.cn',
    HYDROOJ_CLUB_PUSH_SECRET: 'push-secret-0123456789abcdef0123456789abcdef',
    HYDROOJ_CLUB_PULL_SECRET: 'pull-secret-0123456789abcdef0123456789abcdef',
    HYDROOJ_CLUB_ALLOWED_DOMAINS: 'acm-club',
    HYDROOJ_CLUB_SERVICE_ACCOUNT_UID: '1001',
  }
  const backup = Object.fromEntries(Object.entries(env).map(([k]) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  const { config } = loadConfig()
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return config
}

function doc(overrides: Partial<OutboxDoc> = {}): OutboxDoc {
  const now = new Date('2026-10-05T11:00:00Z')
  const bodyText = JSON.stringify({ schemaVersion: 1, eventId: 'e1', instanceId: 'i', domainId: 'acm-club', kind: 'record.snapshot.available', resource: {}, revision: 1, observedAt: now.toISOString() })
  return {
    _id: 'x',
    eventId: randomUUID(),
    resourceKey: 'record:acm-club:670100000000000000000002',
    kind: 'record.snapshot.available',
    domainId: 'acm-club',
    revision: 1,
    bodyText,
    bodyHash: sha256Hex(bodyText),
    status: 'pending',
    attempts: 0,
    runAfter: now,
    leaseOwner: null,
    leaseToken: 'lease-token-1',
    leaseUntil: null,
    lastError: null,
    ackAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('deliverOnce', () => {
  it('POST 固定端点，签名头覆盖原始 body 字节（hydro-to-club canonical）', async () => {
    const config = testConfig()
    const d = doc()
    let captured: { url: string; init: { method: string; headers: Record<string, string>; body: Buffer } } | null = null
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, init }
      return { status: 202 }
    }
    const now = new Date(1759685400_000)
    const res = await deliverOnce(d, config, { fetchImpl, now })
    expect(res.httpStatus).toBe(202)
    expect(captured!.url).toBe(webhookUrl(config))
    expect(captured!.url).toBe('https://club.example.edu.cn/api/v1/integrations/hydro/events')
    expect(captured!.init.method).toBe('POST')
    expect(captured!.init.body.toString('utf8')).toBe(d.bodyText)
    const canonical = hydroCanonical({
      direction: 'hydro-to-club',
      keyId: config.pushKeyId,
      instanceId: config.instanceId,
      timestamp: captured!.init.headers['X-Hydro-Timestamp'],
      nonce: captured!.init.headers['X-Hydro-Nonce'],
      method: 'POST',
      pathAndQuery: '/api/v1/integrations/hydro/events',
      bodySha256: sha256Hex(d.bodyText),
    })
    expect(hydroSign(canonical, config.pushSecret)).toBe(captured!.init.headers['X-Hydro-Signature'])
  })

  it('网络错误/超时返回 null（可重试分类）', async () => {
    const config = testConfig()
    const res = await deliverOnce(doc(), config, {
      fetchImpl: async () => {
        throw new Error('aborted: timeout')
      },
    })
    expect(res.httpStatus).toBeNull()
    expect(res.error).toContain('timeout')
  })
})

describe('runDeliveryRound（租约 → 投递 → 分类落库）', () => {
  const now = new Date('2026-10-05T11:00:00Z')

  function setup(docs: OutboxDoc[], fetchImpl: FetchLike) {
    const outbox = new MockCollection<OutboxDoc>()
    outbox.docs.push(...docs)
    const store = new OutboxStore(outbox, new MockCollection<ResourceDoc>())
    const config = testConfig()
    const round = () => runDeliveryRound({
      store,
      config,
      fetchImpl,
      now: () => now,
      rng: () => 0.5,
    })
    return { outbox, round }
  }

  it('202 成功 → delivered + ackAt', async () => {
    const { outbox, round } = setup([doc()], async () => ({ status: 202 }))
    await round()
    expect(outbox.docs[0]).toMatchObject({ status: 'delivered' })
    expect(outbox.docs[0].ackAt).toEqual(now)
  })

  it('5xx → 退避重试（attempt 1 → 约 5s 后重投），eventId 与 body 保留', async () => {
    const { outbox, round } = setup([doc()], async () => ({ status: 503 }))
    await round()
    expect(outbox.docs[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HTTP 503' })
    expect(outbox.docs[0].runAfter.getTime() - now.getTime()).toBe(5_000)
    expect(outbox.docs[0].bodyText).toBeTruthy()
  })

  it('403（签名/授权配置错误）→ dead letter', async () => {
    const { outbox, round } = setup([doc()], async () => ({ status: 403 }))
    await round()
    expect(outbox.docs[0]).toMatchObject({ status: 'dead', lastError: 'HTTP 403' })
  })

  it('网络错误 → retry；多条事件按并发处理，全部落库', async () => {
    const { outbox, round } = setup(
      [doc({ _id: 'a', eventId: 'a' }), doc({ _id: 'b', eventId: 'b' }), doc({ _id: 'c', eventId: 'c' })],
      async () => {
        throw new Error('ECONNREFUSED')
      },
    )
    await round()
    expect(outbox.docs.map((d) => d.status)).toEqual(['pending', 'pending', 'pending'])
    expect(outbox.docs.every((d) => d.attempts === 1)).toBe(true)
  })

  it('重试退避随 attempts 增长（5s → 30s）', async () => {
    const { outbox, round } = setup([doc({ attempts: 1, runAfter: new Date(now.getTime() - 1) })], async () => ({ status: 500 }))
    await round()
    expect(outbox.docs[0].attempts).toBe(2)
    expect(outbox.docs[0].runAfter.getTime() - now.getTime()).toBe(30_000)
  })
})
