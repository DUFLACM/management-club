import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hydroCanonical, hydroSign, EMPTY_BODY_SHA256 } from '../src/contracts.js'
import { loadConfig } from '../src/config.js'
import { MockCollection } from './helpers/mock-collection.js'

const runtime = vi.hoisted(() => ({
  user: null as any,
  groups: [] as Array<{ name: string }>,
  scoreboardVisible: true,
  recordsVisible: true,
}))
vi.mock('hydrooj', () => {
  class ObjectId { constructor(public hex: string) {} toHexString() { return this.hex } }
  return {
    Handler: class {},
    RecordModel: { RECORD_PRETEST: new ObjectId('0'.repeat(24)) },
    ContestModel: { RULES: { acm: { showScoreboard: () => runtime.scoreboardVisible, showRecord: () => runtime.recordsVisible } } },
    UserModel: { getById: vi.fn(async () => runtime.user), listGroup: vi.fn(async () => runtime.groups) },
    PERM: { PERM_VIEW: 1n, PERM_VIEW_CONTEST: 2n, PERM_VIEW_CONTEST_SCOREBOARD: 4n, PERM_VIEW_RECORD: 8n, PERM_VIEW_HIDDEN_CONTEST: 16n },
    STATUS_TEXTS: {},
  }
})
import { createReadHandlers } from '../src/handlers/read.js'

function setup() {
  const { config } = loadConfig()
  Object.assign(config, { instanceId: '11111111-1111-4111-8111-111111111111', pullKeyId: 'pull-key', pullSecret: 'p'.repeat(40), serviceAccountUid: 1001, allowedDomains: ['acm-club'] })
  const handlers = createReadHandlers({ config, nonces: new MockCollection<{ _id: string; expiresAt: Date }>().withUnique('_id'), hydroVersion: '5.0.7', log: console })
  const handler = new handlers.ContestDetailHandler()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA'
  const path = '/d/acm-club/club-bridge/v1/contests/' + 'a'.repeat(24)
  const canonical = hydroCanonical({ direction: 'club-to-hydro', keyId: config.pullKeyId, instanceId: config.instanceId, timestamp, nonce, method: 'GET', pathAndQuery: path, bodySha256: EMPTY_BODY_SHA256 })
  Object.assign(handler, {
    domain: { _id: 'acm-club' }, response: {},
    request: { method: 'GET', originalPath: path, querystring: '', headers: {
      'x-hydro-key-id': config.pullKeyId, 'x-hydro-instance-id': config.instanceId, 'x-hydro-timestamp': timestamp,
      'x-hydro-nonce': nonce, 'x-hydro-signature': hydroSign(canonical, config.pullSecret),
    } },
  })
  const contest = { domainId: 'acm-club', docId: { toHexString: () => 'a'.repeat(24) }, owner: 100, title: 'private', rule: 'acm', beginAt: new Date(0), endAt: new Date(1), pids: [], assign: [] } as any
  return { handler, contest, config }
}

beforeEach(() => {
  runtime.user = { _id: 1001, hasPerm: (permission: bigint) => permission !== 16n, own: () => false }
  runtime.groups = []
  runtime.scoreboardVisible = true
  runtime.recordsVisible = true
})

describe('只读机器路由权限', () => {
  it('有效 HMAC 仍要求配置的账号具备域与比赛权限', async () => {
    runtime.user = { _id: 1001, hasPerm: () => false, own: () => false }
    const { handler } = setup()
    expect(await handler.prepare()).toBe('cleanup')
    expect(handler.response.status).toBe(403)
    expect(handler.response.body).toMatchObject({ error: { code: 'SERVICE_ACCOUNT_FORBIDDEN' } })
  })

  it('跨域拒绝，不能因有效签名获得所有域访问', async () => {
    const { handler } = setup()
    handler.domain = { _id: 'other' }
    expect(await handler.prepare()).toBe('cleanup')
    expect(handler.response.body).toMatchObject({ error: { code: 'DOMAIN_NOT_ALLOWED' } })
  })

  it('受限赛需要明确比赛授权和账号分组权限', async () => {
    const { handler, contest, config } = setup()
    await handler.prepare()
    contest.assign = ['training']
    config.allowedContests = ['a'.repeat(24)]
    expect(await handler.canExport(contest)).toBe(false)
    runtime.groups = [{ name: 'training' }]
    expect(await handler.canExport(contest)).toBe(true)
    config.allowedContests = []
    config.allowPrivateContests = true
    expect(await handler.canExport(contest)).toBe(false)
  })

  it('隐藏榜单/提交策略生效，即使账号有所有权限仍不得导出', async () => {
    const { handler, contest } = setup()
    runtime.user.hasPerm = () => true
    await handler.prepare()
    runtime.scoreboardVisible = false
    runtime.recordsVisible = false
    expect(await handler.canExport(contest, 'results')).toBe(false)
    expect(await handler.canExport(contest, 'records')).toBe(false)
    runtime.scoreboardVisible = true
    contest.keepScoreboardHidden = true
    expect(await handler.canExport(contest, 'results')).toBe(false)
  })
})
