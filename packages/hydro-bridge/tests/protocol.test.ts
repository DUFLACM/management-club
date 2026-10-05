import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// 主系统共享协议（packages/integrations/src/hydro-protocol.ts，不跨包依赖，测试直接读源文件做交叉验证）
import { hydroCanonical as mainCanonical, hydroSign as mainSign, hydroVerify as mainVerify } from '../../integrations/src/hydro-protocol'
import {
  canonicalPathAndQuery,
  hydroCanonical,
  hydroSign,
  hydroVerify,
  EMPTY_BODY_SHA256,
  isAcceptableNonce,
  percentEncode,
  sha256Hex,
  timestampInRange,
} from '../src/contracts.js'
import { buildWebhookAuthHeaders, verifyMachineGetRequest } from '../src/signature.js'
import type { HydroEventPayload } from '../src/contracts.js'

const here = dirname(fileURLToPath(import.meta.url))
const SECRET = 'test-push-secret-0123456789abcdef0123456789abcdef'
const PULL_SECRET = 'test-pull-secret-0123456789abcdef0123456789abcdef'
const INSTANCE = '11111111-1111-4111-8111-111111111111'

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8')) as T
}

describe('canonical 双端一致（与 packages/integrations/src/hydro-protocol.ts）', () => {
  const input = {
    direction: 'hydro-to-club' as const,
    keyId: 'hydro:11111111-1111-4111-8111-111111111111',
    instanceId: INSTANCE,
    timestamp: '1759685400',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    method: 'post',
    pathAndQuery: '/api/v1/integrations/hydro/events',
    bodySha256: EMPTY_BODY_SHA256,
  }

  it('canonical 布局：9 行、单个 LF 连接、无末尾 LF、方法大写', () => {
    const canonical = hydroCanonical(input)
    expect(canonical.split('\n')).toEqual([
      'HYDRO-BRIDGE-V1',
      'hydro-to-club',
      input.keyId,
      INSTANCE,
      '1759685400',
      'AAAAAAAAAAAAAAAAAAAAAA',
      'POST',
      '/api/v1/integrations/hydro/events',
      EMPTY_BODY_SHA256,
    ])
    expect(canonical.endsWith('\n')).toBe(false)
  })

  it('与主系统实现逐字节一致（hydroCanonical/hydroSign/hydroVerify）', () => {
    expect(hydroCanonical(input)).toBe(mainCanonical(input))
    const c = hydroCanonical(input)
    expect(hydroSign(c, SECRET)).toBe(mainSign(c, SECRET))
    expect(mainVerify(c, hydroSign(c, SECRET), SECRET)).toBe(true)
    expect(hydroVerify(c, mainSign(c, SECRET), SECRET)).toBe(true)
  })

  it('签名/验签为 base64url HMAC-SHA256，长度不等直接拒绝（前缀攻击无效）', () => {
    const c = hydroCanonical(input)
    const signature = hydroSign(c, SECRET)
    expect(signature).toMatch(/^[A-Za-z0-9\-_]+$/)
    expect(hydroVerify(c, signature.slice(0, signature.length - 2), SECRET)).toBe(false)
    expect(hydroVerify(c, `${signature}x`, SECRET)).toBe(false)
  })
})

describe('webhook 事件 fixture 验签（07 方案 5.1/5.2）', () => {
  const event = fixture<HydroEventPayload & { _comment?: string }>('webhook-event.json')
  const body = Buffer.from(JSON.stringify(event, null, 2), 'utf8')

  it('用相同 secret 签名后主系统 hydroVerify 通过（方向 hydro-to-club、POST 固定路径、原始 body 哈希）', () => {
    const headers = buildWebhookAuthHeaders({
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      bodyBuffer: body,
      secret: SECRET,
      now: new Date(1759685400_000),
      nonce: 'fixednonce12345678',
    })
    const canonical = mainCanonical({
      direction: 'hydro-to-club',
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      timestamp: '1759685400',
      nonce: 'fixednonce12345678',
      method: 'POST',
      pathAndQuery: '/api/v1/integrations/hydro/events',
      bodySha256: sha256Hex(body),
    })
    expect(mainVerify(canonical, headers['X-Hydro-Signature'], SECRET)).toBe(true)
  })

  it('篡改一个字节后验签失败（签名覆盖原始 body，不重新序列化）', () => {
    const headers = buildWebhookAuthHeaders({
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      bodyBuffer: body,
      secret: SECRET,
      now: new Date(1759685400_000),
      nonce: 'fixednonce12345678',
    })
    const tampered = Buffer.from(body)
    const pos = tampered.indexOf('3') // revision 首个数字
    tampered[pos] = tampered[pos] === '3' ? '4' : '3'
    const canonical = mainCanonical({
      direction: 'hydro-to-club',
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      timestamp: '1759685400',
      nonce: 'fixednonce12345678',
      method: 'POST',
      pathAndQuery: '/api/v1/integrations/hydro/events',
      bodySha256: sha256Hex(tampered),
    })
    expect(mainVerify(canonical, headers['X-Hydro-Signature'], SECRET)).toBe(false)
  })

  it('secret 不同或 keyId 不同则验签失败', () => {
    const headers = buildWebhookAuthHeaders({
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      bodyBuffer: body,
      secret: SECRET,
      now: new Date(1759685400_000),
      nonce: 'fixednonce12345678',
    })
    const canonical = mainCanonical({
      direction: 'hydro-to-club',
      keyId: `hydro:${INSTANCE}`,
      instanceId: INSTANCE,
      timestamp: '1759685400',
      nonce: 'fixednonce12345678',
      method: 'POST',
      pathAndQuery: '/api/v1/integrations/hydro/events',
      bodySha256: sha256Hex(body),
    })
    expect(mainVerify(canonical, headers['X-Hydro-Signature'], PULL_SECRET)).toBe(false)
    expect(mainVerify(canonical.replace('hydro:', 'other:'), headers['X-Hydro-Signature'], SECRET)).toBe(false)
  })

  it('每次调用生成新 timestamp/nonce（重试不复用）', () => {
    const args = { keyId: 'k', instanceId: INSTANCE, bodyBuffer: body, secret: SECRET } as const
    const a = buildWebhookAuthHeaders(args)
    const b = buildWebhookAuthHeaders(args)
    expect(a['X-Hydro-Nonce']).not.toBe(b['X-Hydro-Nonce'])
  })
})

describe('club-to-hydro pull 机器验证', () => {
  const fixedNow = new Date(1759685400_000)
  const deps = {
    keyId: `hydro-pull:${INSTANCE}`,
    instanceId: INSTANCE,
    secret: PULL_SECRET,
    tryConsumeNonce: async () => true,
    now: fixedNow,
  }

  function signedGet(pathAndQuery: string, overrides: Record<string, string> = {}, now = new Date(1759685400_000)) {
    const timestamp = String(Math.floor(now.getTime() / 1000))
    const nonce = 'pullnonce12345678901234'
    const canonical = mainCanonical({
      direction: 'club-to-hydro',
      keyId: deps.keyId,
      instanceId: INSTANCE,
      timestamp,
      nonce,
      method: 'GET',
      pathAndQuery,
      bodySha256: EMPTY_BODY_SHA256,
    })
    return {
      method: 'GET',
      headers: {
        'x-hydro-key-id': deps.keyId,
        'x-hydro-instance-id': INSTANCE,
        'x-hydro-timestamp': timestamp,
        'x-hydro-nonce': nonce,
        'x-hydro-signature': mainSign(canonical, PULL_SECRET),
        ...overrides,
      },
    }
  }

  it('主系统签名的 GET（空 body sha256、path+query canonical）通过本插件验证', async () => {
    const req = signedGet('/d/acm-club/club-bridge/v1/contests?cursor=670100000000000000000001&limit=100')
    const res = await verifyMachineGetRequest({
      ...req,
      rawPath: '/d/acm-club/club-bridge/v1/contests',
      rawQuery: 'cursor=670100000000000000000001&limit=100',
      allowedQueryKeys: ['cursor', 'limit'],
    }, deps)
    expect(res.ok).toBe(true)
  })

  it('无 query 的请求 canonical 仅含 path', async () => {
    const req = signedGet('/d/acm-club/club-bridge/v1/capabilities')
    const res = await verifyMachineGetRequest({
      ...req,
      rawPath: '/d/acm-club/club-bridge/v1/capabilities',
      rawQuery: null,
      allowedQueryKeys: [],
    }, deps)
    expect(res.ok).toBe(true)
  })

  it('方法非 GET、缺头、key 不匹配、时间窗、签名错均拒绝', async () => {
    const base = {
      rawPath: '/club-bridge/v1/capabilities',
      rawQuery: null,
      allowedQueryKeys: [] as string[],
    }
    expect((await verifyMachineGetRequest({ ...signedGet('/club-bridge/v1/capabilities'), ...base, method: 'POST' }, deps)).ok).toBe(false)
    const noSig = signedGet('/club-bridge/v1/capabilities')
    expect((await verifyMachineGetRequest({ ...noSig, ...base, headers: { ...noSig.headers, 'x-hydro-signature': '' } }, deps)).code).toBe('SIG_HEADER_MISSING')
    const badKey = signedGet('/club-bridge/v1/capabilities')
    expect((await verifyMachineGetRequest({ ...badKey, ...base, headers: { ...badKey.headers, 'x-hydro-key-id': 'other' } }, deps)).code).toBe('KEY_MISMATCH')
    const stale = signedGet('/club-bridge/v1/capabilities', {}, new Date(1759685400_000 - 301_000))
    expect((await verifyMachineGetRequest({ ...stale, ...base }, deps)).code).toBe('TIMESTAMP_OUT_OF_RANGE')
    const forged = signedGet('/club-bridge/v1/capabilities')
    expect((await verifyMachineGetRequest({ ...forged, ...base, headers: { ...forged.headers, 'x-hydro-signature': mainSign('HYDRO-BRIDGE-V1\nx', PULL_SECRET) } }, deps)).code).toBe('SIGNATURE_INVALID')
  })

  it('nonce 弱值/重放拒绝', async () => {
    const base = { rawPath: '/club-bridge/v1/capabilities', rawQuery: null, allowedQueryKeys: [] as string[] }
    const weak = signedGet('/club-bridge/v1/capabilities')
    const res = await verifyMachineGetRequest({
      ...weak,
      ...base,
      headers: { ...weak.headers, 'x-hydro-nonce': 'short' },
    }, deps)
    expect(res.ok).toBe(false)
    const seen = new Set<string>()
    const replayDeps = { ...deps, tryConsumeNonce: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)) }
    const req = signedGet('/club-bridge/v1/capabilities')
    const first = await verifyMachineGetRequest({ ...req, ...base }, replayDeps)
    const second = await verifyMachineGetRequest({ ...req, ...base }, replayDeps)
    expect(first.ok).toBe(true)
    expect(second.ok === false && second.code).toBe('NONCE_REPLAY')
  })
})

describe('query 唯一规范形式与纯函数', () => {
  it('接受排序、声明字段、规范编码的 query', () => {
    expect(canonicalPathAndQuery('/p', 'cursor=abc&limit=5', ['cursor', 'limit'])).toBe('/p?cursor=abc&limit=5')
  })

  it('拒绝重复键/未排序/未声明字段/非规范编码/缺 =', () => {
    expect(canonicalPathAndQuery('/p', 'a=1&a=2', ['a'])).toBeNull()
    expect(canonicalPathAndQuery('/p', 'z=1&a=2', ['a', 'z'])).toBeNull()
    expect(canonicalPathAndQuery('/p', 'a=1&secret=2', ['a'])).toBeNull()
    expect(canonicalPathAndQuery('/p', 'a=1&flag', ['a', 'flag'])).toBeNull()
    expect(canonicalPathAndQuery('/p', `a=${encodeURIComponent('中文')}`, ['a'])).not.toBeNull()
    expect(canonicalPathAndQuery('/p', 'a=%zz', ['a'])).toBeNull()
    expect(canonicalPathAndQuery('', 'a=1', ['a'])).toBeNull()
  })

  it('percentEncode 为严格 RFC 3986（空格 %20、!\'()* 转义、中文三字节）', () => {
    expect(percentEncode('a b')).toBe('a%20b')
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A')
    expect(percentEncode('A-z9._~')).toBe('A-z9._~')
    expect(percentEncode('中')).toBe('%E4%B8%AD')
  })

  it('时间戳 ±300 秒窗口与 nonce 强度', () => {
    const now = 1_759_685_400_000
    expect(timestampInRange('1759685400', now)).toBe(true)
    expect(timestampInRange(String(1759685400 - 300), now)).toBe(true)
    expect(timestampInRange(String(1759685400 - 301), now)).toBe(false)
    expect(timestampInRange(String(1759685400 + 301), now)).toBe(false)
    expect(timestampInRange('not-a-number', now)).toBe(false)
    expect(isAcceptableNonce('shortnonce123')).toBe(false)
    expect(isAcceptableNonce('0123456789abcdef')).toBe(false)
    expect(isAcceptableNonce('0123456789abcdef012345')).toBe(true)
    expect(isAcceptableNonce('has spaces and!symbols')).toBe(false)
  })
})
