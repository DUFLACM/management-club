import type { Context, ObjectId, Tdoc } from 'hydrooj'
import { ContestModel, Handler, RecordModel, UserModel, PERM, STATUS_TEXTS } from 'hydrooj'
import { CLUB_BRIDGE_ROUTES, sha256Hex, stableStringify, WEBHOOK_PATH } from '../contracts.js'
import type { BridgeConfig } from '../config.js'
import { verifyMachineGetRequest, type PullVerifyFailureCode } from '../signature.js'
import { isDuplicateKeyError, type MongoCollection } from '../mongo-types.js'
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  computeResults,
  iso,
  KNOWN_RULES,
  projectContestMeta,
  projectParticipant,
  projectRecord,
  RESULT_RULES,
} from '../adapters/hydro-v5.js'

/**
 * club-bridge 只读路由（07 方案 7，拟新增域内 API，用 ctx.Route 注册）。
 *
 * 机器鉴权：校验与主系统相同的 HYDRO-BRIDGE-V1 HMAC（direction=club-to-hydro，
 * GET 空 body sha256，path+query canonical；path 为线上原始路径，含 /d/{domainId} 前缀）。
 * HMAC 只证明"来自已登记主系统"，不继承任何用户会话；域必须在校方允许域列表内；
 * 受限比赛（assign/口令）仅在显式授权（allowedContests/allowPrivate）时可导出。
 * 无权读取的字段整体省略；永不输出 code/testCases/judgeTexts/compilerTexts。
 */

export const DEFAULT_PAGE_LIMIT = 200
export const MAX_PAGE_LIMIT = 200
export const MAX_RESPONSE_BYTES = 1024 * 1024

export const NONCE_COLLECTION = 'club_bridge.nonces'

export interface ReadRouteDeps {
  config: BridgeConfig
  nonces: MongoCollection<{ _id: string; expiresAt: Date }>
  hydroVersion: string
  log: { warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void }
}

interface ServiceUser {
  _id: number
  hasPerm(permission: bigint): boolean
  own(doc: { owner?: number }): boolean
}

const FAILURE_STATUS: Record<PullVerifyFailureCode | 'DOMAIN_NOT_ALLOWED' | 'SERVICE_ACCOUNT_FORBIDDEN' | 'CONTEST_NOT_FOUND' | 'CONTEST_RESTRICTED' | 'BAD_REQUEST' | 'INTERNAL_ERROR', number> = {
  METHOD_NOT_ALLOWED: 405,
  BODY_NOT_EMPTY: 400,
  SIG_HEADER_MISSING: 401,
  KEY_MISMATCH: 401,
  TIMESTAMP_OUT_OF_RANGE: 401,
  NONCE_WEAK: 400,
  NONCE_REPLAY: 409,
  QUERY_NOT_CANONICAL: 400,
  SIGNATURE_INVALID: 403,
  DOMAIN_NOT_ALLOWED: 403,
  SERVICE_ACCOUNT_FORBIDDEN: 403,
  CONTEST_NOT_FOUND: 404,
  CONTEST_RESTRICTED: 403,
  BAD_REQUEST: 400,
  INTERNAL_ERROR: 500,
}

/** 分页 query 允许的键（唯一规范形式：按键排序、RFC3986 编码、无重复键） */
const PAGE_QUERY_KEYS: readonly string[] = ['cursor', 'limit']
const NO_QUERY_KEYS: readonly string[] = []

/** 从 Hydro 自身常量获取 ObjectId 构造器（不引入 mongodb 运行时依赖） */
export function getHydroObjectIdCtor(): (new (hex: string) => ObjectId) | null {
  const seed = (RecordModel as unknown as { RECORD_PRETEST?: { constructor: unknown } }).RECORD_PRETEST
  if (!seed || typeof seed.constructor !== 'function') return null
  return seed.constructor as new (hex: string) => ObjectId
}

function pageOptions(rawQuery: string | null | undefined): { limit: number; cursor: string | null } | null {
  if (!rawQuery) return { limit: DEFAULT_PAGE_LIMIT, cursor: null }
  const out: Record<string, string> = {}
  for (const part of rawQuery.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1))
  }
  let limit = DEFAULT_PAGE_LIMIT
  let cursor: string | null = null
  if (out.limit !== undefined) {
    if (!/^\d+$/.test(out.limit)) return null
    limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number(out.limit)))
  }
  if (out.cursor !== undefined) {
    if (out.cursor === '' || out.cursor.length > 128) return null
    cursor = out.cursor
  }
  return { limit, cursor }
}

/** 响应体不超过 1 MiB：按页裁剪并给出 nextCursor */
function fitPage<T>(items: T[], limit: number, sizeOf: (item: T) => number, idOf: (item: T) => string): { page: T[]; nextCursor: string | null } {
  const page: T[] = []
  let used = 0
  for (const item of items.slice(0, limit)) {
    const size = sizeOf(item)
    if (used + size > MAX_RESPONSE_BYTES - 65_536) break
    page.push(item)
    used += size
    if (used > MAX_RESPONSE_BYTES) break
  }
  const consumed = page.length
  return { page, nextCursor: consumed < items.length && consumed > 0 ? idOf(page[page.length - 1]) : null }
}

export function createReadHandlers(deps: ReadRouteDeps) {
  const { config } = deps
  const ObjectIdCtor = getHydroObjectIdCtor()
  const asHexObjectId = (value: string): ObjectId | null => {
    if (!/^[0-9a-f]{24}$/i.test(value) || !ObjectIdCtor) return null
    return new ObjectIdCtor(value)
  }

  abstract class ClubBridgeHandler extends Handler {
    // 机器接口独立校验已登记账号，不依赖匿名浏览器会话的 PERM_VIEW。
    noCheckPermView = true
    machineAuthed = false
    serviceUser: ServiceUser | null = null
    queryKeys: readonly string[] = NO_QUERY_KEYS

    fail(code: keyof typeof FAILURE_STATUS, message: string): string {
      this.response.status = FAILURE_STATUS[code]
      this.response.body = { schemaVersion: 1, error: { code, message } }
      this.response.template = null
      this.response.type = 'application/json'
      return 'cleanup'
    }

    async prepare(): Promise<string | void> {
      this.response.template = null
      this.response.type = 'application/json'
      const result = await verifyMachineGetRequest(
        {
          method: this.request.method,
          rawPath: this.request.originalPath,
          rawQuery: this.request.querystring || null,
          headers: this.request.headers,
          allowedQueryKeys: this.queryKeys,
        },
        {
          keyId: config.pullKeyId,
          instanceId: config.instanceId,
          secret: config.pullSecret,
          tryConsumeNonce: async (nonceKey, expiresAt) => {
            try {
              await deps.nonces.insertOne({ _id: nonceKey, expiresAt })
              return true
            } catch (error) {
              if (isDuplicateKeyError(error)) return false
              throw error
            }
          },
        },
      )
      if (!result.ok) {
        if (result.code === 'SIGNATURE_INVALID') deps.log.warn('club-bridge: pull 签名校验失败（path=%s）', this.request.originalPath)
        return this.fail(result.code, result.message)
      }
      this.machineAuthed = true
      const domainId = this.requireDomain()
      if (!domainId) return this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表')
      this.serviceUser = await UserModel.getById(domainId, config.serviceAccountUid)
      if (!this.serviceUser || ![PERM.PERM_VIEW, PERM.PERM_VIEW_CONTEST].every((permission) => this.serviceUser!.hasPerm(permission))) {
        return this.fail('SERVICE_ACCOUNT_FORBIDDEN', '服务账号缺少域或比赛读取权限')
      }
      return undefined
    }

    async canExport(tdoc: Tdoc, kind: 'meta' | 'records' | 'results' = 'meta'): Promise<boolean> {
      const user = this.serviceUser
      if (!this.machineAuthed || !user) return false
      if (tdoc.assign?.length && !user.own(tdoc) && !user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
        const groups = await UserModel.listGroup(tdoc.domainId, user._id)
        if (!groups.some((group) => tdoc.assign!.includes(group.name))) return false
      }
      const rule = ContestModel.RULES[tdoc.rule]
      // 首期不导出隐藏榜单，即便服务账号有管理员/隐藏榜单权限。
      if (kind === 'results' && (!user.hasPerm(PERM.PERM_VIEW_CONTEST_SCOREBOARD) || !rule?.showScoreboard(tdoc, new Date()) || tdoc.keepScoreboardHidden)) return false
      if (kind === 'records' && (!user.hasPerm(PERM.PERM_VIEW_RECORD) || !rule?.showRecord(tdoc, new Date()))) return false
      return projectContestMeta(tdoc, new Date(), { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests }).exportable === true
    }

    requireDomain(): string | null {
      const domainId = this.domain?._id
      if (!domainId || !config.allowedDomains.includes(domainId)) return null
      return domainId
    }

    envelope(domainId: string | null, data: Record<string, unknown>): Record<string, unknown> {
      const generatedAt = new Date().toISOString()
      const response = {
        schemaVersion: 1,
        instanceId: config.instanceId,
        ...(domainId ? { domainId } : {}),
        ...data,
        snapshotHash: sha256Hex(stableStringify({ ...data, generatedAt })),
        generatedAt,
      }
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES) throw new Error('club-bridge: 响应超过 1 MiB 上限')
      return response
    }
  }

  class CapabilitiesHandler extends ClubBridgeHandler {
    async all(): Promise<void> {
      this.response.body = this.envelope(null, {
        adapter: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        hydroVersion: deps.hydroVersion,
        sourceVersion: deps.hydroVersion,
        instanceId: config.instanceId,
        allowedDomains: config.allowedDomains,
        knownRules: KNOWN_RULES,
        resultRules: RESULT_RULES,
        webhook: { endpoint: `${config.endpoint}${WEBHOOK_PATH}`, keyId: config.pushKeyId },
        routes: {
          capabilities: CLUB_BRIDGE_ROUTES.capabilities,
          contests: CLUB_BRIDGE_ROUTES.contests,
          participants: CLUB_BRIDGE_ROUTES.participants(':tid'),
          records: CLUB_BRIDGE_ROUTES.records(':tid'),
          results: CLUB_BRIDGE_ROUTES.results(':tid'),
        },
        pagination: { defaultLimit: DEFAULT_PAGE_LIMIT, maxLimit: MAX_PAGE_LIMIT },
        maxResponseBytes: MAX_RESPONSE_BYTES,
        /** 校方服务账号需授予的最小权限（ capabilities 声明，不授予隐藏榜单/源码读取） */
        serviceAccountPerms: [
          PERM.PERM_VIEW.toString(),
          PERM.PERM_VIEW_CONTEST.toString(),
          PERM.PERM_VIEW_CONTEST_SCOREBOARD.toString(),
          PERM.PERM_VIEW_RECORD.toString(),
        ],
        serverTime: new Date().toISOString(),
      })
    }
  }

  class ContestsHandler extends ClubBridgeHandler {
    queryKeys = PAGE_QUERY_KEYS

    async all(): Promise<void> {
      const domainId = this.requireDomain()
      if (!domainId) { this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表'); return }
      const opts = pageOptions(this.request.querystring || null)
      if (!opts) { this.fail('BAD_REQUEST', '分页参数不合法'); return }
      const query: Record<string, unknown> = {}
      if (opts.cursor) {
        const cursorOid = asHexObjectId(opts.cursor)
        if (!cursorOid) { this.fail('BAD_REQUEST', 'cursor 不合法'); return }
        query.docId = { $lt: cursorOid }
      }
      const tdocs = await ContestModel.getMulti(domainId, query).sort({ docId: -1 }).limit(opts.limit + 1).toArray()
      const now = new Date()
      const projected = await Promise.all(tdocs.map(async (tdoc) => {
        const meta = projectContestMeta(tdoc, now, { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests })
        if (await this.canExport(tdoc)) return meta
        // 未授权受限赛：仅存在性标记，省略标题/时间/赛制等字段
        return { docId: meta.docId, domainId, visibility: 'restricted', exportable: false }
      }))
      const { page, nextCursor } = fitPage(projected, opts.limit, (i) => Buffer.byteLength(JSON.stringify(i), 'utf8'), (i) => String((i as { docId: string }).docId))
      this.response.body = this.envelope(domainId, { contests: page, nextCursor })
    }
  }

  class ContestDetailHandler extends ClubBridgeHandler {
    async all(): Promise<void> {
      const domainId = this.requireDomain()
      if (!domainId) { this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表'); return }
      const tid = String(this.request.params.tid ?? '')
      const tidOid = asHexObjectId(tid)
      if (!tidOid) { this.fail('BAD_REQUEST', 'tid 不是合法 ObjectId'); return }
      const tdoc = await ContestModel.get(domainId, tidOid).catch(() => null)
      if (!tdoc) { this.fail('CONTEST_NOT_FOUND', '比赛不存在'); return }
      const meta = projectContestMeta(tdoc, new Date(), { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests })
      if (!await this.canExport(tdoc)) {
        this.response.body = this.envelope(domainId, { contest: { docId: meta.docId, domainId, visibility: 'restricted', exportable: false } })
        return
      }
      this.response.body = this.envelope(domainId, { contest: meta })
    }
  }

  class ParticipantsHandler extends ClubBridgeHandler {
    queryKeys = PAGE_QUERY_KEYS

    async all(): Promise<void> {
      const domainId = this.requireDomain()
      if (!domainId) { this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表'); return }
      const tidOid = asHexObjectId(String(this.request.params.tid ?? ''))
      if (!tidOid) { this.fail('BAD_REQUEST', 'tid 不是合法 ObjectId'); return }
      const tdoc = await ContestModel.get(domainId, tidOid).catch(() => null)
      if (!tdoc) { this.fail('CONTEST_NOT_FOUND', '比赛不存在'); return }
      const meta = projectContestMeta(tdoc, new Date(), { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests })
      if (!await this.canExport(tdoc)) { this.fail('CONTEST_RESTRICTED', '受限比赛未授权导出'); return }
      const opts = pageOptions(this.request.querystring || null)
      if (!opts) { this.fail('BAD_REQUEST', '分页参数不合法'); return }
      const query: Record<string, unknown> = { docId: tidOid }
      if (opts.cursor) {
        if (!/^\d+$/.test(opts.cursor)) { this.fail('BAD_REQUEST', 'cursor 不合法'); return }
        query.uid = { $gt: Number(opts.cursor) }
      }
      const tsdocs = await ContestModel.getMultiStatus(domainId, query).sort({ uid: 1 }).limit(opts.limit + 1).toArray()
      const participants = tsdocs.map((tsdoc) => ({ ...projectParticipant(tsdoc), rev: typeof tsdoc.rev === 'number' ? tsdoc.rev : null }))
      const { page, nextCursor } = fitPage(participants, opts.limit, (i) => Buffer.byteLength(JSON.stringify(i), 'utf8'), (i) => String((i as Record<string, unknown>).uid))
      this.response.body = this.envelope(domainId, {
        docId: tidOid.toHexString(),
        attendance: typeof tdoc.attend === 'number' ? tdoc.attend : 0,
        participants: page,
        nextCursor,
      })
    }
  }

  class RecordsHandler extends ClubBridgeHandler {
    queryKeys = PAGE_QUERY_KEYS

    async all(): Promise<void> {
      const domainId = this.requireDomain()
      if (!domainId) { this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表'); return }
      const tidOid = asHexObjectId(String(this.request.params.tid ?? ''))
      if (!tidOid) { this.fail('BAD_REQUEST', 'tid 不是合法 ObjectId'); return }
      const tdoc = await ContestModel.get(domainId, tidOid).catch(() => null)
      if (!tdoc) { this.fail('CONTEST_NOT_FOUND', '比赛不存在'); return }
      const meta = projectContestMeta(tdoc, new Date(), { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests })
      if (!await this.canExport(tdoc, 'records')) { this.fail('CONTEST_RESTRICTED', '比赛提交不可导出'); return }
      const opts = pageOptions(this.request.querystring || null)
      if (!opts) { this.fail('BAD_REQUEST', '分页参数不合法'); return }
      const query: Record<string, unknown> = { contest: tidOid }
      if (opts.cursor) {
        const cursorOid = asHexObjectId(opts.cursor)
        if (!cursorOid) { this.fail('BAD_REQUEST', 'cursor 不合法'); return }
        query._id = { $gt: cursorOid }
      }
      // 仅投影元数据白名单字段；code/testCases/judgeTexts/compilerTexts 永不进入响应
      const rdocs = await RecordModel.getMulti(domainId, query, {
        projection: {
          _id: 1, uid: 1, pid: 1, contest: 1, status: 1,
          score: 1, lang: 1, judgeAt: 1, rejudged: 1, domainId: 1,
        },
      }).sort({ _id: 1 }).limit(opts.limit + 1).toArray()
      const records = rdocs.map((rdoc) => projectRecord({ ...rdoc, domainId: rdoc.domainId ?? domainId }, STATUS_TEXTS))
      const { page, nextCursor } = fitPage(records, opts.limit, (i) => Buffer.byteLength(JSON.stringify(i), 'utf8'), (i) => String((i as { recordId: string }).recordId))
      this.response.body = this.envelope(domainId, { docId: tidOid.toHexString(), records: page, nextCursor })
    }
  }

  class ResultsHandler extends ClubBridgeHandler {
    async all(): Promise<void> {
      const domainId = this.requireDomain()
      if (!domainId) { this.fail('DOMAIN_NOT_ALLOWED', '域未在允许列表'); return }
      const tidOid = asHexObjectId(String(this.request.params.tid ?? ''))
      if (!tidOid) { this.fail('BAD_REQUEST', 'tid 不是合法 ObjectId'); return }
      const tdoc = await ContestModel.get(domainId, tidOid).catch(() => null)
      if (!tdoc) { this.fail('CONTEST_NOT_FOUND', '比赛不存在'); return }
      const meta = projectContestMeta(tdoc, new Date(), { allowedContests: config.allowedContests, allowPrivate: config.allowPrivateContests })
      if (!await this.canExport(tdoc, 'results')) { this.fail('CONTEST_RESTRICTED', '比赛榜单不可导出'); return }
      const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tidOid, attend: { $gte: 1 } }).sort({ uid: 1 }).limit(5001).toArray()
      if (tsdocs.length > 5000) { this.fail('BAD_REQUEST', '参赛人数超过单次快照上限，需校方适配分页'); return }
      const results = computeResults({ tdoc, tsdocs, now: new Date() })
      if (results.status === 'final') {
        results.status = 'pending_review'
        results.integrity.note += '；未在学校实际版本核对排名与终判，须人工审核'
      }
      this.response.body = this.envelope(domainId, {
        docId: tidOid.toHexString(),
        title: tdoc.title,
        beginAt: iso(tdoc.beginAt),
        endAt: iso(tdoc.endAt),
        results,
      })
    }
  }

  return { CapabilitiesHandler, ContestsHandler, ContestDetailHandler, ParticipantsHandler, RecordsHandler, ResultsHandler }
}

export function registerReadRoutes(ctx: Context, deps: ReadRouteDeps): void {
  const h = createReadHandlers(deps)
  ctx.Route('club_bridge_capabilities', CLUB_BRIDGE_ROUTES.capabilities, h.CapabilitiesHandler)
  ctx.Route('club_bridge_contests', CLUB_BRIDGE_ROUTES.contests, h.ContestsHandler)
  ctx.Route('club_bridge_contest_detail', CLUB_BRIDGE_ROUTES.contest(':tid'), h.ContestDetailHandler)
  ctx.Route('club_bridge_contest_participants', CLUB_BRIDGE_ROUTES.participants(':tid'), h.ParticipantsHandler)
  ctx.Route('club_bridge_contest_records', CLUB_BRIDGE_ROUTES.records(':tid'), h.RecordsHandler)
  ctx.Route('club_bridge_contest_results', CLUB_BRIDGE_ROUTES.results(':tid'), h.ResultsHandler)
}
