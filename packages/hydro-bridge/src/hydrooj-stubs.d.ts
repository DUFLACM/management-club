/**
 * hydrooj 最小类型声明（仅构建期使用）。
 *
 * 本包把 hydrooj 作为 peer dependency（>=5.0.7 <6），由学校 Hydro 实例在运行时
 * 提供（addon 通过 require 加载 dist，真实 hydrooj 从 Hydro 安装目录解析）。
 * hydrooj npm 包只发布 TypeScript 源码、且使用其自身宽松 toolchain 编译，
 * 独立构建无法对其做严格类型检查，因此这里按 5.0.7 实际 API
 * （packages/hydrooj/src/plugin-api.ts、service/context.ts、service/server.ts、
 * model/contest.ts、model/record.ts、@hydrooj/framework）声明本插件用到的最小类型。
 *
 * ⚠️ 真实类型以学校实例安装的 hydrooj 版本为准；上线前必须按 07 方案 §11 在
 * 学校实际版本上做加载与联调验证。
 */

declare module 'hydrooj' {
  // ---- mongodb 结构子集（与真实 mongodb driver 结构兼容） ----
  export class ObjectId {
    constructor(id?: string | number | ObjectId | { toHexString(): string })
    toHexString(): string
    getTimestamp(): Date
    equals(other: unknown): boolean
    toString(): string
    static isValid(v: unknown): boolean
  }

  export interface FindCursor<T> {
    sort(spec: Record<string, 1 | -1>): FindCursor<T>
    limit(n: number): FindCursor<T>
    skip(n: number): FindCursor<T>
    toArray(): Promise<T[]>
  }

  export interface MongoFilter {
    [key: string]: any
  }

  export interface Collection<T extends { _id: unknown }> {
    findOne(filter: MongoFilter): Promise<T | null>
    find(filter?: MongoFilter, options?: { sort?: Record<string, 1 | -1>; limit?: number; skip?: number }): FindCursor<T>
    insertOne(doc: T): Promise<{ insertedId: unknown }>
    updateOne(filter: MongoFilter, update: MongoFilter, options?: { upsert?: boolean }): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }>
    findOneAndUpdate(filter: MongoFilter, update: MongoFilter, options?: { returnDocument?: 'before' | 'after'; sort?: Record<string, 1 | -1> }): Promise<{ ok: 1; value: T | null }>
    deleteMany(filter: MongoFilter): Promise<{ deletedCount: number }>
    countDocuments(filter?: MongoFilter): Promise<number>
    createIndex(keys: Record<string, 1 | -1>, options?: { name?: string; unique?: boolean; expireAfterSeconds?: number }): Promise<string>
  }

  // ---- 文档类型（interface.ts 的结构子集，含真实字段的宽松索引签名） ----
  export interface Tdoc {
    _id: unknown
    docId: ObjectId
    docType: 30
    domainId: string
    owner: number
    title: string
    rule: string
    beginAt: Date
    endAt: Date
    attend: number
    pids: number[]
    rated?: boolean
    assign?: string[]
    lockAt?: Date
    unlocked?: boolean
    autoHide?: boolean
    keepScoreboardHidden?: boolean
    /** 灵活时长（小时） */
    duration?: number
    /** 参赛口令存在与否的标志（值不导出） */
    _code?: string
    [key: string]: any
  }

  export interface ContestDetailEntry {
    rid?: ObjectId
    pid?: number
    score?: number
    status?: number
    time?: number
    real?: number
    penalty?: number
    naccept?: number
    npending?: number
    [key: string]: any
  }

  export interface ContestStatusDoc {
    _id: unknown
    domainId: string
    docId: ObjectId
    docType: 30
    uid: number
    attend?: number
    startAt?: Date
    endAt?: Date
    rev?: number
    unrank?: boolean
    detail?: Record<string, ContestDetailEntry>
    display?: Record<string, ContestDetailEntry>
    score?: number
    originalScore?: number
    accept?: number
    time?: number
    penaltyScore?: number
    journal?: unknown[]
    members?: number[]
    [key: string]: any
  }

  export interface RecordDoc {
    _id: ObjectId
    domainId: string
    uid: number
    pid: number
    contest?: ObjectId
    status: number
    score?: number
    time?: number
    memory?: number
    lang: string
    judgeAt?: Date
    rejudged?: boolean
    [key: string]: any
  }

  // ---- 权限与状态常量（@hydrooj/common，经 model/builtin 再导出） ----
  export const PERM: {
    PERM_VIEW: bigint
    PERM_VIEW_USER_PRIVATE_INFO: bigint
    PERM_VIEW_CONTEST: bigint
    PERM_VIEW_CONTEST_SCOREBOARD: bigint
    PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: bigint
    PERM_VIEW_HIDDEN_CONTEST: bigint
    PERM_ATTEND_CONTEST: bigint
    PERM_VIEW_RECORD: bigint
    PERM_READ_RECORD_CODE: bigint
    PERM_READ_RECORD_CODE_ACCEPT: bigint
    [key: string]: bigint
  }

  export enum STATUS {
    STATUS_WAITING = 0,
    STATUS_ACCEPTED = 1,
    STATUS_WRONG_ANSWER = 2,
    STATUS_TIME_LIMIT_EXCEEDED = 3,
    STATUS_MEMORY_LIMIT_EXCEEDED = 4,
    STATUS_OUTPUT_LIMIT_EXCEEDED = 5,
    STATUS_RUNTIME_ERROR = 6,
    STATUS_COMPILE_ERROR = 7,
    STATUS_SYSTEM_ERROR = 8,
    STATUS_CANCELED = 9,
    STATUS_ETC = 10,
    STATUS_HACKED = 11,
    STATUS_JUDGING = 20,
    STATUS_COMPILING = 21,
    STATUS_FETCHED = 22,
    STATUS_IGNORED = 30,
    STATUS_FORMAT_ERROR = 31,
    STATUS_HACK_SUCCESSFUL = 32,
    STATUS_HACK_UNSUCCESSFUL = 33,
  }

  export const STATUS_TEXTS: Record<number, string>

  // ---- 模型（真实为 namespace / class 的静态成员，这里按同样形状声明） ----
  export namespace ContestModel {
    export function get(domainId: string, tid: ObjectId): Promise<Tdoc>
    export function getMulti(domainId: string, query?: MongoFilter): FindCursor<Tdoc>
    export function getStatus(domainId: string, tid: ObjectId, uid: number): Promise<ContestStatusDoc | null>
    export function getMultiStatus(domainId: string, query?: MongoFilter): FindCursor<ContestStatusDoc>
    export function countStatus(domainId: string, query?: MongoFilter): Promise<number>
    export function isLocked(tdoc: Tdoc, time?: Date): boolean
    export const RULES: Record<string, {
      statusSort: Record<string, 1 | -1>
      hidden?: boolean
      showScoreboard(tdoc: Tdoc, now: Date): boolean
      showRecord(tdoc: Tdoc, now: Date): boolean
    }>
  }

  export interface ServiceUser {
    _id: number
    hasPerm(permission: bigint): boolean
    own(doc: { owner?: number }): boolean
  }
  export namespace UserModel {
    function getById(domainId: string, uid: number): Promise<ServiceUser | null>
    function listGroup(domainId: string, uid: number): Promise<Array<{ name: string }>>
  }

  export class RecordModel {
    static get(_id: ObjectId): Promise<RecordDoc | null>
    static get(domainId: string, _id: ObjectId): Promise<RecordDoc | null>
    static getMulti(domainId: string, query?: MongoFilter, options?: { sort?: Record<string, 1 | -1>; limit?: number; skip?: number; projection?: Record<string, 0 | 1> }): FindCursor<RecordDoc>
  }

  // ---- 插件集合声明扩展（07 方案 2.1：只写自有集合，不动核心集合） ----
  export interface Collections {
    'club_bridge.outbox': Collection<import('./outbox.js').OutboxDoc>
    'club_bridge.resources': Collection<import('./outbox.js').ResourceDoc>
    'club_bridge.nonces': Collection<{ _id: string; expiresAt: Date }>
  }

  // ---- Context（cordis Context + Hydro 注入的 db/Route/interval 等） ----
  export interface Context {
    /** Mongo 服务（应用 prefix/collectionMap；不要自行拼接连接串） */
    db: {
      collection<K extends keyof Collections>(c: K): Collections[K]
    }
    /** 注册 HTTP 路由（框架 router.all；路径为 /d/{domainId} 剥离后的域内路径） */
    Route(name: string, path: string, handler: new (...args: any[]) => Handler, ...permPrivChecker: unknown[]): unknown
    on<K extends keyof Events>(event: K, listener: (...args: Parameters<Events[K]>) => any): unknown
    interval(fn: () => void | Promise<void>, ms: number): () => void
    effect(dispose: () => unknown): unknown
  }

  // ---- 事件（service/bus.ts EventMap 的结构子集；不存在的事件不得猜测） ----
  export interface Events {
    'dispose': () => void
    /** 判题后调用；updated 来自题目状态更新，false 也不能忽略 */
    'record/judge': (rdoc: RecordDoc, updated: boolean, pdoc?: unknown, updater?: unknown) => void
    /** 创建、过程更新、重判重置等都可能出现；需合并重复脏标记 */
    'record/change': (rdoc: RecordDoc, $set?: any, $push?: any, body?: any) => void
    /** payload 未保证包含 domainId，需在允许域内回查 */
    'contest/add': (payload: Partial<Tdoc>, id: ObjectId) => void
    'contest/edit': (payload: Tdoc) => void
    /** 调用点与删除操作并行，不能认定已删除完成 */
    'contest/del': (domainId: string, tid: ObjectId) => void
    /** 生成/读取榜单时的 hook；不是比赛结束或成绩更改通知，不用于结赛 */
    'contest/scoreboard': (tdoc: Tdoc, rows: unknown[], udict: unknown, pdict: unknown) => void
  }

  // ---- Handler（@hydrooj/framework + hydrooj service/server 的结构子集） ----
  export interface HydroRequest {
    method: string
    host: string
    hostname: string
    ip: string
    headers: Record<string, unknown>
    query: Record<string, unknown>
    querystring: string
    path: string
    originalPath: string
    params: Record<string, string>
    json: boolean
    referer: string
  }

  export interface HydroResponse {
    body: unknown
    type: string
    status: number | null
    template?: string | null
    etag?: string
    addHeader(name: string, value: string): void
  }

  export class Handler {
    request: HydroRequest
    response: HydroResponse
    args: Record<string, any>
    session: Record<string, any>
    domain: { _id: string; [key: string]: any }
    constructor(...args: any[])
    prepare?(args: Record<string, any>): Promise<any | void>
    all?(args: Record<string, any>): Promise<any | void>
    cleanup?(args: Record<string, any>): Promise<any | void>
    onerror(error: unknown): void
  }
}
