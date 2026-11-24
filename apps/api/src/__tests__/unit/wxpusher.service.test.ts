import { afterEach, describe, expect, it, vi } from 'vitest'
import { WxPusherService, formatWxPusherMarkdown } from '../../modules/notifications/wxpusher.service.js'
import type { PrismaService, SchemaStateService } from '../../infrastructure/database/database.module.js'
import type { JobsService } from '../../infrastructure/jobs/jobs.service.js'

function createMockSchema(wxpusherReady = true): SchemaStateService {
  return { announcementsReady: true, notificationsReady: true, wxpusherReady } as SchemaStateService
}

describe('WxPusherService', () => {
  const originalToken = process.env.WXPUSHER_APP_TOKEN

  afterEach(() => {
    if (originalToken === undefined) delete process.env.WXPUSHER_APP_TOKEN
    else process.env.WXPUSHER_APP_TOKEN = originalToken
  })

  it('formats markdown summary within 100 chars and builds absolute app URL', () => {
    const res = formatWxPusherMarkdown({
      tag: '积分变动',
      title: 'A'.repeat(120),
      body: '项目「第 12 场周赛」入账 +5 分',
      link: '/app?section=points',
    })
    expect(res.summary.length).toBeLessThanOrEqual(100)
    expect(res.url).toMatch(/^https?:\/\/.*\/app\?section=points$/)
    expect(res.content).toContain('[前往协会系统查看详情](')
  })

  it('binds user atomically on valid app_subscribe webhook and enqueues welcome push', async () => {
    process.env.WXPUSHER_APP_TOKEN = 'AT_test_token_only'
    const tokenRow = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      token: 'abcdef0123456789abcdef0123456789',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    }
    const upsertSpy = vi.fn().mockResolvedValue({})
    const deleteManySpy = vi.fn().mockResolvedValue({ count: 0 })
    const tx = {
      wxPusherBindToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      userWxPusherBinding: {
        deleteMany: deleteManySpy,
        upsert: upsertSpy,
      },
    }
    const db = {
      wxPusherBindToken: {
        findUnique: vi.fn().mockResolvedValue(tokenRow),
      },
      userWxPusherBinding: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          notifyPoints: true,
          notifyApprovals: true,
          notifyActivities: true,
          notifyCompetitions: true,
          notifyAnnouncements: true,
        }),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService

    const enqueueSpy = vi.fn().mockResolvedValue({ id: 'job-1', deduplicated: false })
    const jobs = { enqueue: enqueueSpy } as unknown as JobsService
    const service = new WxPusherService(db, createMockSchema(true), jobs)

    const result = await service.handleWebhook({
      action: 'app_subscribe',
      data: {
        uid: 'UID_testuser123456',
        extra: tokenRow.token,
        time: Date.now(),
      },
    })

    expect(result).toEqual({ accepted: true, bound: true })
    expect(deleteManySpy).toHaveBeenCalledTimes(1)
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.wxpusher_send',
        payload: expect.objectContaining({
          userId: tokenRow.userId,
          force: true,
        }),
      }),
    )
  })

  it('rejects expired or unknown extra token in webhook without mutating bindings', async () => {
    const db = {
      wxPusherBindToken: {
        findUnique: vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          token: 'expiredtoken',
          expiresAt: new Date(Date.now() - 10_000),
          consumedAt: null,
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaService

    const service = new WxPusherService(db, createMockSchema(true))
    const result = await service.handleWebhook({
      action: 'app_subscribe',
      data: { uid: 'UID_testuser123456', extra: 'expiredtoken' },
    })

    expect(result).toEqual({ accepted: true, bound: false, reason: 'token_invalid_or_expired' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('skips enqueueing push when user disabled that category preference', async () => {
    process.env.WXPUSHER_APP_TOKEN = 'AT_test_token_only'
    const db = {
      userWxPusherBinding: {
        findUnique: vi.fn().mockResolvedValue({
          enabled: true,
          notifyPoints: false,
          notifyApprovals: true,
          notifyActivities: true,
          notifyCompetitions: true,
          notifyAnnouncements: true,
        }),
      },
    } as unknown as PrismaService
    const enqueueSpy = vi.fn()
    const service = new WxPusherService(db, createMockSchema(true), { enqueue: enqueueSpy } as unknown as JobsService)

    await service.enqueueUserPush({
      userId: '22222222-2222-4222-8222-222222222222',
      preferenceKey: 'points',
      tag: '积分变动',
      title: '积分变动：+5 分',
      body: '测试',
    })

    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})
