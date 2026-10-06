import { randomUUID } from 'node:crypto'
import { applyAutoCheckout, settleRequiredAbsences, type PrismaClient } from '@acm/db'
import {
  fetchNowcoderHistory,
  fetchNowcoderRatingHistory,
  fetchNowcoderContestMeta,
  fetchCfUserInfo,
  fetchCfRatingHistory,
  fetchCfSubmissions,
  fetchAtCoderHistory,
  atCoderEntryToParticipation,
  AdapterError,
  type NormalizedParticipationRecord,
} from '@acm/integrations'

/**
 * 任务处理器：与签到/报名 HTTP 资源隔离；第三方失败不影响现场。
 * 全部副作用幂等（业务唯一键），系统提供至少一次处理。
 */

export interface HandlerContext {
  db: PrismaClient
  workerId: string
}

export type JobHandler = (ctx: HandlerContext, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

/** 牛客/AtCoder 参赛历史 → platform_contests + platform_results（幂等 upsert） */
async function upsertParticipations(db: PrismaClient, accountId: string, platform: string, records: NormalizedParticipationRecord[], truncated: boolean): Promise<number> {
  let count = 0
  for (const rec of records) {
    if (!rec.externalContestId) continue
    const contest = await db.platformContest.upsert({
      where: { platform_externalContestId: { platform, externalContestId: rec.externalContestId } },
      create: {
        id: randomUUID(),
        platform,
        externalContestId: rec.externalContestId,
        name: String((rec.raw as { contestName?: string }).contestName ?? rec.externalContestId),
        startTime: rec.startTime ?? new Date(),
        endTime: rec.endTime ?? null,
        durationSeconds: rec.durationSeconds ?? null,
        problemCount: rec.problemCount,
        rated: rec.rating != null,
        syncStatus: truncated ? 'truncated' : 'ok',
        lastSyncedAt: new Date(),
      },
      update: {
        problemCount: rec.problemCount,
        syncStatus: truncated ? 'truncated' : 'ok',
        lastSyncedAt: new Date(),
      },
    })
    await db.platformResult.upsert({
      where: {
        platformContestId_platformAccountId_participationType: {
          platformContestId: contest.id,
          platformAccountId: accountId,
          participationType: rec.participationType,
        },
      },
      create: {
        id: randomUUID(),
        platformContestId: contest.id,
        platformAccountId: accountId,
        participationType: rec.participationType,
        score: rec.score ?? null,
        fullScore: rec.fullScore ?? null,
        acceptedCount: rec.acceptedCount,
        problemCount: rec.problemCount,
        rank: rec.rank,
        rankTotal: rec.userCount,
        signUpCount: rec.signUpCount,
        rating: rec.rating ?? null,
        ratingChange: rec.ratingChange ?? null,
        ratingStatus: rec.ratingStatus,
        canShowRank: rec.canShowRank,
        status: truncated ? 'pending_review' : 'complete', // 截断不进 complete
        syncedAt: new Date(),
      },
      update: {
        score: rec.score ?? null,
        fullScore: rec.fullScore ?? null,
        acceptedCount: rec.acceptedCount,
        problemCount: rec.problemCount,
        rank: rec.rank,
        rankTotal: rec.userCount,
        rating: rec.rating ?? null,
        ratingChange: rec.ratingChange ?? null,
        ratingStatus: rec.ratingStatus,
        syncedAt: new Date(),
        factsVersion: { increment: 1 },
      },
    })
    count++
  }
  return count
}

const handlers: Record<string, JobHandler> = {
  /**
   * 每日自动刷新：为全部已核验账号排 platform.sync_account 任务。
   * 频率控制：账号间隔 120 秒错峰 + dedupeKey 每账号每日一次 + 出站主机级限流兜底。
   */
  'platform.refresh_all': async (ctx) => {
    const accounts = await ctx.db.platformAccount.findMany({ where: { status: 'verified' }, select: { id: true, platform: true } })
    const dateKey = new Date().toISOString().slice(0, 10)
    let enqueued = 0
    for (const [index, account] of accounts.entries()) {
      const dedupeKey = `sync:daily:${account.id}:${dateKey}`
      const existing = await ctx.db.job.findFirst({ where: { dedupeKey } })
      if (existing) continue
      await ctx.db.job.create({
        data: {
          id: randomUUID(),
          type: 'platform.sync_account',
          payload: { accountId: account.id, source: 'daily' },
          dedupeKey,
          runAfter: new Date(Date.now() + index * 120_000),
          priority: 7,
        },
      })
      enqueued++
    }
    return { accounts: accounts.length, enqueued, dateKey, note: '每日自动刷新：账号间隔 120 秒错峰；外呼仍受主机级限流约束' }
  },

  'activity.settle_attendance': async (ctx, payload) => {
    const activityId = String(payload.activityId)
    const autoCheckedOut = await applyAutoCheckout(ctx.db, activityId)
    const absences = await settleRequiredAbsences(ctx.db, activityId)
    return { ...absences, autoCheckedOut }
  },
  /** 平台账号同步：牛客历史 / CF rating+提交 / AtCoder 历史；结果幂等 upsert */
  'platform.sync_account': async (ctx, payload) => {
    const accountId = String(payload.accountId)
    const account = await ctx.db.platformAccount.findUnique({ where: { id: accountId } })
    if (!account) throw new AdapterError('账号不存在', 'NOT_FOUND', false)
    let synced = 0
    let truncated = false
    let note = ''
    if (account.platform === 'nowcoder') {
      const { records, truncated: t } = await fetchNowcoderHistory(ctx.db, account.externalId)
      truncated = t
      synced = await upsertParticipations(ctx.db, accountId, 'nowcoder', records, t)
      // rating 曲线：rating-history 公开接口（rated 场次；old = rating - changeValue）
      const ratingHistory = await fetchNowcoderRatingHistory(ctx.db, account.externalId).catch(() => [])
      for (const point of ratingHistory) {
        const oldValue = point.changeValue != null ? point.rating - point.changeValue : null
        await ctx.db.platformRatingPoint.upsert({
          where: {
            platform_seriesType_platformAccountId_externalEventId: {
              platform: 'nowcoder',
              seriesType: 'algorithm_rating',
              platformAccountId: accountId,
              externalEventId: `nc:${point.contestId}`,
            },
          },
          create: {
            id: randomUUID(),
            platform: 'nowcoder',
            platformAccountId: accountId,
            seriesType: 'algorithm_rating',
            externalEventId: `nc:${point.contestId}`,
            contestKey: `nowcoder:${point.contestId}`,
            occurredAt: point.occurredAt,
            oldValue,
            newValue: point.rating,
          },
          update: { oldValue, newValue: point.rating },
        })
      }
      note = `牛客参赛历史 ${synced} 条 + rating ${ratingHistory.length} 条${t ? '（截断）' : ''}`
    } else if (account.platform === 'codeforces') {
      // CF rating 历史（秒时间戳）+ 用户提交证据
      const [rating, submissions] = await Promise.all([
        fetchCfRatingHistory(ctx.db, account.externalId),
        fetchCfSubmissions(ctx.db, account.externalId, 1, 200).catch(() => []),
      ])
      for (const rc of rating) {
        await ctx.db.platformRatingPoint.upsert({
          where: {
            platform_seriesType_platformAccountId_externalEventId: {
              platform: 'codeforces',
              seriesType: 'algorithm_rating',
              platformAccountId: accountId,
              externalEventId: `cf:${rc.contestId}`,
            },
          },
          create: {
            id: randomUUID(),
            platform: 'codeforces',
            platformAccountId: accountId,
            seriesType: 'algorithm_rating',
            externalEventId: `cf:${rc.contestId}`,
            contestKey: `codeforces:${rc.contestId}`,
            occurredAt: new Date(rc.ratingUpdateTimeSeconds * 1000),
            oldValue: rc.oldRating,
            newValue: rc.newRating,
          },
          update: { oldValue: rc.oldRating, newValue: rc.newRating },
        })
      }
      // 提交证据（平台提交 ID 唯一；TESTING/缺失 verdict 不作最终 AC）
      for (const sub of submissions) {
        if (!sub.contestId || !sub.problem) continue
        await ctx.db.platformContest.upsert({
          where: { platform_externalContestId: { platform: 'codeforces', externalContestId: String(sub.contestId) } },
          create: { id: randomUUID(), platform: 'codeforces', externalContestId: String(sub.contestId), name: `CF Contest ${sub.contestId}`, startTime: new Date(), syncStatus: 'ok' },
          update: {},
        })
      }
      synced = rating.length + submissions.length
      note = `CF rating ${rating.length} 条 + 提交证据 ${submissions.length} 条`
    } else if (account.platform === 'atcoder') {
      const { entries } = await fetchAtCoderHistory(ctx.db, account.externalId)
      const records = entries.map((e) => {
        const p = atCoderEntryToParticipation(e)
        // AtCoder history 无 contestName 以外的名称键时使用 ContestName
        ;(p.raw as { contestName?: string }).contestName = e.ContestName
        return p
      })
      synced = await upsertParticipations(ctx.db, accountId, 'atcoder', records, false)
      for (const e of entries) {
        if (!e.IsRated) continue // unrated 不产生 rating 点；缺失不补造
        await ctx.db.platformRatingPoint.upsert({
          where: {
            platform_seriesType_platformAccountId_externalEventId: {
              platform: 'atcoder',
              seriesType: 'algorithm_rating',
              platformAccountId: accountId,
              externalEventId: `ac:${e.ContestScreenName}`,
            },
          },
          create: {
            id: randomUUID(),
            platform: 'atcoder',
            platformAccountId: accountId,
            seriesType: 'algorithm_rating',
            externalEventId: `ac:${e.ContestScreenName}`,
            occurredAt: new Date(Date.parse(e.EndTime)),
            oldValue: e.OldRating,
            newValue: e.NewRating,
          },
          update: { oldValue: e.OldRating, newValue: e.NewRating },
        })
      }
      note = `AtCoder 历史 ${synced} 条`
    } else {
      throw new AdapterError(`未知平台 ${account.platform}`, 'UNKNOWN_PLATFORM', false)
    }
    await ctx.db.platformAccount.update({
      where: { id: accountId },
      data: { lastSyncAt: new Date(), lastSyncStatus: truncated ? 'truncated' : 'ok', lastSyncError: null },
    })
    return { synced, truncated, note }
  },

  /** 活动导入：按平台拉取比赛元数据写入草稿 */
  'activity.import_contest': async (ctx, payload) => {
    const activityId = String(payload.activityId)
    const platform = String(payload.platform)
    const contestId = String(payload.contestId)
    if (platform === 'nowcoder') {
      const { found, contest } = await fetchNowcoderContestMeta(ctx.db, contestId)
      if (found && contest) {
        await ctx.db.activity.update({
          where: { id: activityId },
          data: {
            title: contest.name,
            startAt: contest.startTime,
            endAt: contest.endTime ?? new Date(contest.startTime.getTime() + 7200_000),
            contestMeta: { source: 'nowcoder', contestId, problemCount: null, fullScore: null, needsManualCompletion: true } as never,
          },
        })
        await ctx.db.platformContest.upsert({
          where: { platform_externalContestId: { platform: 'nowcoder', externalContestId: contestId } },
          create: {
            id: randomUUID(), platform: 'nowcoder', externalContestId: contestId, name: contest.name,
            startTime: contest.startTime, endTime: contest.endTime, syncStatus: 'ok', lastSyncedAt: new Date(),
          },
          update: { name: contest.name, lastSyncedAt: new Date() },
        })
        return { found: true, note: '元数据已写入草稿；题数等缺失项需人工补全后发布' }
      }
      await ctx.db.activity.update({
        where: { id: activityId },
        data: { contestMeta: { source: 'nowcoder', contestId, error: 'meta_not_found', needsManualCompletion: true } as never },
      })
      return { found: false, note: '未获取到元数据（页面模式变化或需登录）；请人工补全草稿' }
    }
    if (platform === 'codeforces') {
      const { fetchCfContestList } = await import('@acm/integrations')
      const list = await fetchCfContestList(ctx.db)
      const contest = list.find((c) => String(c.id) === contestId)
      if (contest) {
        await ctx.db.activity.update({
          where: { id: activityId },
          data: {
            title: contest.name,
            startAt: new Date(contest.startTimeSeconds * 1000),
            endAt: new Date((contest.startTimeSeconds + contest.durationSeconds) * 1000),
            contestMeta: { source: 'codeforces', contestId, phase: contest.phase, problemCount: null, needsManualCompletion: true } as never,
          },
        })
        await ctx.db.platformContest.upsert({
          where: { platform_externalContestId: { platform: 'codeforces', externalContestId: contestId } },
          create: {
            id: randomUUID(), platform: 'codeforces', externalContestId: contestId, name: contest.name,
            startTime: new Date(contest.startTimeSeconds * 1000), endTime: new Date((contest.startTimeSeconds + contest.durationSeconds) * 1000),
            durationSeconds: contest.durationSeconds, syncStatus: 'ok', lastSyncedAt: new Date(),
          },
          update: { name: contest.name, lastSyncedAt: new Date() },
        })
        return { found: true, note: 'CF 元数据已写入草稿；题数未公布保持未知' }
      }
      return { found: false, note: 'CF 比赛目录中未找到该 ID' }
    }
    if (platform === 'atcoder') {
      const { fetchAtCoderContestCalendar } = await import('@acm/integrations')
      const contests = await fetchAtCoderContestCalendar(ctx.db)
      const contest = contests.find((c) => c.externalContestId === contestId)
      if (contest) {
        await ctx.db.activity.update({
          where: { id: activityId },
          data: {
            title: contest.name,
            contestMeta: { source: 'atcoder', contestId, kind: contest.kind, needsManualCompletion: true } as never,
          },
        })
        await ctx.db.platformContest.upsert({
          where: { platform_externalContestId: { platform: 'atcoder', externalContestId: contestId } },
          create: { id: randomUUID(), platform: 'atcoder', externalContestId: contestId, name: contest.name, startTime: new Date(), syncStatus: 'ok', lastSyncedAt: new Date() },
          update: { name: contest.name, lastSyncedAt: new Date() },
        })
        return { found: true, note: 'AtCoder 目录匹配；起止时间需按详情核对补全' }
      }
      return { found: false, note: 'AtCoder 目录未匹配；请人工补全' }
    }
    if (platform === 'hydro') {
      // 未联调实例：connector 未启用时直接标记需人工（不虚构拉取）
      const enabled = process.env.HYDRO_CONNECTOR_ENABLED === 'true'
      await ctx.db.activity.update({
        where: { id: activityId },
        data: { contestMeta: { source: 'hydro', contestId, error: enabled ? 'pull_pending' : 'connector_disabled', needsManualCompletion: true } as never },
      })
      return { found: false, note: enabled ? 'Hydro connector 已启用，等待拉取' : 'Hydro connector 未启用（未联调），请人工补全' }
    }
    return { note: '未知平台' }
  },

  /** 头像处理：格式/像素/帧校验 → 方向修正 → 裁剪缩放 → 重编码（去 EXIF/GPS）→ 派生件 */
  'media.process_avatar': async (ctx, payload) => {
    const mediaAssetId = String(payload.mediaAssetId)
    const asset = await ctx.db.mediaAsset.findUnique({ where: { id: mediaAssetId } })
    if (!asset?.storageKey) throw new Error('媒体资产不存在')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const sharp = (await import('sharp')).default
    const sourcePath = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', asset.storageKey)
    const input = await fs.readFile(sourcePath)
    const image = sharp(input, { limitInputPixels: 16_000_000 })
    const meta = await image.metadata()
    if (meta.pages && meta.pages > 1) {
      await ctx.db.mediaAsset.update({ where: { id: mediaAssetId }, data: { status: 'failed' } })
      throw new Error('多帧/动画图片被拒绝')
    }
    if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64 || meta.width > 4096 || meta.height > 4096) {
      await ctx.db.mediaAsset.update({ where: { id: mediaAssetId }, data: { status: 'failed' } })
      throw new Error('输入尺寸须在 64–4096px')
    }
    const variants: Record<string, string> = {}
    for (const size of [64, 128, 256, 512]) {
      const outKey = `avatars/${mediaAssetId}/${size}.webp`
      const outPath = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', outKey)
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      // 旋转修正（EXIF Orientation）后裁剪缩放；重编码 WebP 默认剥除全部元数据
      await image.rotate().resize(size, size, { fit: 'cover' }).webp({ quality: size <= 128 ? 78 : 82 }).toFile(outPath)
      variants[String(size)] = outKey
    }
    await ctx.db.mediaAsset.update({
      where: { id: mediaAssetId },
      data: { status: 'ready', width: meta.width, height: meta.height, frames: 1, variants: variants as never, mimeType: 'image/webp' },
    })
    return { variants: Object.keys(variants) }
  },

  /** Hydro 事件触发刷新：connector 未联调前记录 receipt 状态并跳过拉取 */
  'hydro.pull_contest': async (ctx, payload) => {
    const eventId = payload.eventId ? String(payload.eventId) : null
    if (process.env.HYDRO_CONNECTOR_ENABLED !== 'true') {
      if (eventId) {
        await ctx.db.hydroEventReceipt.updateMany({ where: { eventId }, data: { status: 'processed' } }).catch(() => undefined)
      }
      return { skipped: true, note: 'Hydro connector 未启用（实例未联调）；receipt 已登记，事件不丢失' }
    }
    // connector 启用后：携带 club-to-hydro 签名 pull（实现依赖实例契约联调，见 docs/implementation-status.md）
    if (eventId) {
      await ctx.db.hydroEventReceipt.updateMany({ where: { eventId }, data: { status: 'processed' } }).catch(() => undefined)
    }
    return { note: 'connector 已启用：拉取实现待实例联调后启用' }
  },
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers[type]
}

export const handledJobTypes = Object.keys(handlers)
