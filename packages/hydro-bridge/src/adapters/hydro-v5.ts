import { stableStringify } from '../contracts.js'

/**
 * Hydro v5 最小投影适配（07 方案 7）。
 *
 * 纯函数模块：不 import hydrooj（类型用本文件的结构接口表达，与真实
 * Tdoc/ContestStatusDoc/RecordDoc 兼容），便于在无 Hydro 运行时的环境做
 * 单元测试与 fixture 对照。真实榜单/排名以学校实例的原生赛制实现为准，
 * 本适配的产出必须逐赛制与原生榜单对照后方可进入自动计算（07 §11.2）。
 *
 * 关键语义：
 * - 题目数 = tdoc.pids.length；ACM 与 OI/IOI 分数语义不同（ACM 用 accept/罚时 time，
 *   OI 用 score），未知赛制返回 pending_review；
 * - 封榜（lockAt 已过且未 unlocked）期间 display ≠ detail，只输出 display 派生数据
 *   并标记 derivedFrom，不产出最终名次；
 * - 所有输出均为明确 JSON 类型与 ISO UTC 时间；绝不输出 code/testCases/judgeTexts/
 *   compilerTexts、题面、口令、privateFiles 或成员联系方式。
 */

export const ADAPTER_ID = 'hydro-v5'
export const ADAPTER_VERSION = '0.1.0'

/** 已适配可输出最终名次的赛制；其余一律 pending_review（人工导入兜底） */
export const RESULT_RULES: readonly string[] = ['acm', 'oi', 'ioi', 'strictioi']
/** 目录/元数据可读的已知赛制 */
export const KNOWN_RULES: readonly string[] = ['acm', 'oi', 'ioi', 'strictioi', 'homework', 'ledo']

export interface HydroContestDoc {
  docId: { toHexString(): string }
  domainId: string
  title: string
  rule: string
  beginAt: Date
  endAt: Date
  pids: number[]
  attend?: number
  rated?: boolean
  owner?: number
  assign?: string[]
  lockAt?: Date | null
  unlocked?: boolean
  autoHide?: boolean
  keepScoreboardHidden?: boolean
  duration?: number | null
  /** 口令字段仅判断是否存在，值不导出 */
  _code?: string
  [key: string]: unknown
}

export interface HydroContestDetailEntry {
  rid?: unknown
  pid?: number
  score?: number
  status?: number
  time?: number
  real?: number
  penalty?: number
  naccept?: number
  npending?: number
  [key: string]: unknown
}

export interface HydroStatusDoc {
  uid: number
  domainId?: string
  docId?: unknown
  attend?: number
  startAt?: Date | null
  endAt?: Date | null
  rev?: number
  unrank?: boolean
  detail?: Record<string, HydroContestDetailEntry> | null
  display?: Record<string, HydroContestDetailEntry> | null
  score?: number
  originalScore?: number
  accept?: number
  time?: number
  penaltyScore?: number
  members?: number[]
  [key: string]: unknown
}

export interface HydroRecordDoc {
  _id: { toHexString(): string }
  domainId: string
  uid: number
  pid: number
  contest?: { toHexString(): string } | null
  status: number
  score?: number | null
  time?: number | null
  memory?: number | null
  lang: string
  judgeAt?: Date | null
  rejudged?: boolean
  [key: string]: unknown
}

export const STATUS_ACCEPTED = 1

export function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null
}

/** 封榜：lockAt 已过且未解锁（与 ContestModel.isLocked 同语义） */
export function isFrozen(tdoc: HydroContestDoc, now: Date): boolean {
  if (!tdoc.lockAt) return false
  return tdoc.lockAt < now && !tdoc.unlocked
}

export function isEnded(tdoc: HydroContestDoc, now: Date): boolean {
  return now >= tdoc.endAt
}

/** 受限可见性：指定分组（assign）或口令赛 */
export function isRestricted(tdoc: HydroContestDoc): boolean {
  return (Array.isArray(tdoc.assign) && tdoc.assign.length > 0) || typeof tdoc._code === 'string'
}

export function contestVisibility(tdoc: HydroContestDoc): 'public' | 'restricted' {
  return isRestricted(tdoc) ? 'restricted' : 'public'
}

/** 比赛最小元数据投影（不含题面/口令/privateFiles/content） */
export function projectContestMeta(
  tdoc: HydroContestDoc,
  now: Date,
  options: { allowedContests: readonly string[]; allowPrivate: boolean },
): Record<string, unknown> {
  const frozen = isFrozen(tdoc, now)
  return {
    docId: tdoc.docId.toHexString(),
    domainId: tdoc.domainId,
    title: tdoc.title,
    rule: tdoc.rule,
    ruleKnown: KNOWN_RULES.includes(tdoc.rule),
    beginAt: iso(tdoc.beginAt),
    endAt: iso(tdoc.endAt),
    problemCount: Array.isArray(tdoc.pids) ? tdoc.pids.length : 0,
    rated: !!tdoc.rated,
    attendance: typeof tdoc.attend === 'number' ? tdoc.attend : 0,
    durationHours: typeof tdoc.duration === 'number' ? tdoc.duration : null,
    frozen,
    lock: {
      lockAt: iso(tdoc.lockAt ?? null),
      unlocked: !!tdoc.unlocked,
      isLocked: frozen,
    },
    scoreboard: {
      displayOnly: frozen,
      detailAvailable: !frozen,
    },
    ended: isEnded(tdoc, now),
    autoHide: !!tdoc.autoHide,
    keepScoreboardHidden: !!tdoc.keepScoreboardHidden,
    visibility: contestVisibility(tdoc),
    exportable: !isRestricted(tdoc) || options.allowedContests.includes(tdoc.docId.toHexString()),
  }
}

/** 参赛方最小投影：真实 OJ 登记状态与团队关系；不含邮箱/联系方式/其他域分组 */
export function projectParticipant(tsdoc: HydroStatusDoc): Record<string, unknown> {
  return {
    uid: tsdoc.uid,
    attend: typeof tsdoc.attend === 'number' ? tsdoc.attend >= 1 : false,
    startAt: iso(tsdoc.startAt ?? null),
    endAt: iso(tsdoc.endAt ?? null),
    unrank: !!tsdoc.unrank,
    ...(Array.isArray(tsdoc.members) && tsdoc.members.length ? { teamMembers: tsdoc.members } : {}),
  }
}

/**
 * 提交最小元数据投影。显式白名单字段——即使源文档带 code/testCases/judgeTexts/
 * compilerTexts/files 也不会出现在输出（07 方案 7 默认排除列）。
 */
export function projectRecord(rdoc: HydroRecordDoc, statusTexts: Record<number, string>): Record<string, unknown> {
  return {
    recordId: rdoc._id.toHexString(),
    uid: rdoc.uid,
    contestId: rdoc.contest ? rdoc.contest.toHexString() : null,
    pid: rdoc.pid,
    status: rdoc.status,
    statusText: statusTexts[rdoc.status] ?? null,
    score: typeof rdoc.score === 'number' ? rdoc.score : null,
    lang: rdoc.lang,
    judgeAt: iso(rdoc.judgeAt ?? null),
    rejudged: !!rdoc.rejudged,
  }
}

export interface ResultsEntryAcm {
  rank: number | null
  uid: number
  accept: number
  time: number
  unrank: boolean
  tied: boolean
}

export interface ResultsEntryScore {
  rank: number | null
  uid: number
  score: number
  unrank: boolean
  tied: boolean
}

export interface FrozenEntry {
  rank: null
  uid: number
  unrank: boolean
  derivedFrom: 'display'
  derived: { accept?: number; score?: number }
  problems: Record<string, Pick<HydroContestDetailEntry, 'status' | 'score' | 'time' | 'naccept' | 'npending'>>
}

export interface ContestResults {
  rule: string
  /** final=已结束且未封榜（可授权导出最终名次）；frozen=封榜中（仅 display 派生）；
   *  running=未结束；pending_review=赛制未适配，人工核对 */
  status: 'final' | 'frozen' | 'running' | 'pending_review'
  detailAvailable: boolean
  frozen: boolean
  ended: boolean
  entries: Array<ResultsEntryAcm | ResultsEntryScore | FrozenEntry> | null
  entryKind: 'acm' | 'score' | 'display' | null
  integrity: {
    ended: boolean
    frozen: boolean
    /** 判题是否全部终判无法从模型直接证明，保留 null（不伪造完整性结论） */
    judgeComplete: null
    participantCount: number
    rankedCount: number
    problemCount: number
    maxStatusRevision: number | null
    note: string
  }
}

/** 结赛结果快照（ACM/OI 语义分开；封榜仅 display；未知赛制 pending_review） */
export function computeResults(input: {
  tdoc: HydroContestDoc
  tsdocs: HydroStatusDoc[]
  now: Date
}): ContestResults {
  const { tdoc, tsdocs, now } = input
  const participantCount = tsdocs.length
  const problemCount = Array.isArray(tdoc.pids) ? tdoc.pids.length : 0
  const maxStatusRevision = tsdocs.reduce<number | null>((acc, t) => (typeof t.rev === 'number' && t.rev > (acc ?? -1) ? t.rev : acc), null)
  const baseIntegrity = (note: string, rankedCount = 0) => ({
    ended: isEnded(tdoc, now),
    frozen: isFrozen(tdoc, now),
    judgeComplete: null,
    participantCount,
    rankedCount,
    problemCount,
    maxStatusRevision,
    note,
  })

  if (!RESULT_RULES.includes(tdoc.rule)) {
    return {
      rule: tdoc.rule,
      status: 'pending_review',
      detailAvailable: !isFrozen(tdoc, now),
      frozen: isFrozen(tdoc, now),
      ended: isEnded(tdoc, now),
      entries: null,
      entryKind: null,
      integrity: baseIntegrity('赛制未适配（或缺少与原生榜单的对照验证），返回 pending_review，成绩以人工导入核对为准'),
    }
  }
  if (isFrozen(tdoc, now)) {
    const entries: FrozenEntry[] = tsdocs.map((t) => {
      const problems: FrozenEntry['problems'] = {}
      for (const [pid, d] of Object.entries(t.display ?? {})) {
        problems[pid] = {
          status: d.status,
          score: d.score,
          time: d.time,
          naccept: d.naccept,
          npending: d.npending,
        }
      }
      const derived: FrozenEntry['derived'] = tdoc.rule === 'acm'
        ? { accept: Object.values(t.display ?? {}).filter((d) => d.status === STATUS_ACCEPTED).length }
        : { score: Object.values(t.display ?? {}).reduce((acc, d) => acc + (typeof d.score === 'number' ? d.score : 0), 0) }
      return { rank: null, uid: t.uid, unrank: !!t.unrank, derivedFrom: 'display', derived, problems }
    })
    return {
      rule: tdoc.rule,
      status: 'frozen',
      detailAvailable: false,
      frozen: true,
      ended: isEnded(tdoc, now),
      entries,
      entryKind: 'display',
      integrity: baseIntegrity('封榜期间 display ≠ detail：仅输出 display 派生数据，不产出最终名次；解锁后回拉 detail'),
    }
  }
  if (!isEnded(tdoc, now)) {
    return {
      rule: tdoc.rule,
      status: 'running',
      detailAvailable: true,
      frozen: false,
      ended: false,
      entries: null,
      entryKind: null,
      integrity: baseIntegrity('比赛未结束，不产出结赛快照；按 1/6/24/72 小时回拉计划重试'),
    }
  }
  if (tdoc.rule === 'acm') {
    const entries = rankAcm(tsdocs)
    return {
      rule: 'acm',
      status: 'final',
      detailAvailable: true,
      frozen: false,
      ended: true,
      entries,
      entryKind: 'acm',
      integrity: baseIntegrity('ACM 语义：rank 按 accept 降序、罚时 time 升序；并列同 rank；unrank 不参与排名', entries.filter((e) => e.rank !== null).length),
    }
  }
  const entries = rankByScore(tsdocs)
  return {
    rule: tdoc.rule,
    status: 'final',
    detailAvailable: true,
    frozen: false,
    ended: true,
    entries,
    entryKind: 'score',
    integrity: baseIntegrity('OI/IOI 语义：rank 按总分 score 降序；并列同 rank；unrank 不参与排名', entries.filter((e) => e.rank !== null).length),
  }
}

/** ACM 排名：accept 降序、time（罚时+用时秒）升序；竞争排名（并列同 rank） */
export function rankAcm(tsdocs: HydroStatusDoc[]): ResultsEntryAcm[] {
  const sorted = [...tsdocs].sort((a, b) => {
    const aa = a.unrank ? -1 : 0
    const bb = b.unrank ? -1 : 0
    if (bb !== aa) return bb - aa
    const aAcc = a.accept ?? 0
    const bAcc = b.accept ?? 0
    if (aAcc !== bAcc) return bAcc - aAcc
    return (a.time ?? 0) - (b.time ?? 0)
  })
  let lastRank = 0
  return sorted.map((t, i) => {
    if (t.unrank) return { rank: null, uid: t.uid, accept: t.accept ?? 0, time: t.time ?? 0, unrank: true, tied: false }
    const tie = i > 0 && !sorted[i - 1].unrank && (sorted[i - 1].accept ?? 0) === (t.accept ?? 0) && (sorted[i - 1].time ?? 0) === (t.time ?? 0)
    const rank = tie ? lastRank : i + 1
    lastRank = rank
    return { rank, uid: t.uid, accept: t.accept ?? 0, time: t.time ?? 0, unrank: false, tied: tie }
  })
}

/** OI/IOI 排名：score 降序；竞争排名（并列同 rank） */
export function rankByScore(tsdocs: HydroStatusDoc[]): ResultsEntryScore[] {
  const sorted = [...tsdocs].sort((a, b) => {
    const aa = a.unrank ? -1 : 0
    const bb = b.unrank ? -1 : 0
    if (bb !== aa) return bb - aa
    return (b.score ?? 0) - (a.score ?? 0)
  })
  let lastRank = 0
  return sorted.map((t, i) => {
    if (t.unrank) return { rank: null, uid: t.uid, score: t.score ?? 0, unrank: true, tied: false }
    const tie = i > 0 && !sorted[i - 1].unrank && (sorted[i - 1].score ?? 0) === (t.score ?? 0)
    const rank = tie ? lastRank : i + 1
    lastRank = rank
    return { rank, uid: t.uid, score: t.score ?? 0, unrank: false, tied: tie }
  })
}

// ---- 事件侧最小源快照（只含资源引用 + 最小状态，07 方案 3/5.1） ----

/** contest 元数据源快照（用于源哈希；口令/题面等不出现在快照） */
export function contestSourceSnapshot(tdoc: HydroContestDoc, now: Date): Record<string, unknown> {
  return {
    kind: 'contest',
    docId: tdoc.docId.toHexString(),
    domainId: tdoc.domainId,
    title: tdoc.title,
    rule: tdoc.rule,
    beginAt: iso(tdoc.beginAt),
    endAt: iso(tdoc.endAt),
    pids: Array.isArray(tdoc.pids) ? [...tdoc.pids] : [],
    attend: tdoc.attend ?? 0,
    rated: !!tdoc.rated,
    locked: isFrozen(tdoc, now),
    unlocked: !!tdoc.unlocked,
  }
}

/** record 终判状态源快照（最小终判事实；无 code/个人信息） */
export function recordSourceSnapshot(rdoc: HydroRecordDoc): Record<string, unknown> {
  return {
    kind: 'record',
    recordId: rdoc._id.toHexString(),
    domainId: rdoc.domainId,
    uid: rdoc.uid,
    contestId: rdoc.contest ? rdoc.contest.toHexString() : null,
    pid: rdoc.pid,
    status: rdoc.status,
    score: typeof rdoc.score === 'number' ? rdoc.score : null,
    lang: rdoc.lang,
    judgeAt: iso(rdoc.judgeAt ?? null),
    rejudged: !!rdoc.rejudged,
  }
}

/** 删除事实快照（contest/del 观察到的待核验删除） */
export function deletedContestSnapshot(domainId: string, docId: string, confirmations: number): Record<string, unknown> {
  return { kind: 'contest-deleted', domainId, docId, confirmations }
}

/** 源哈希：稳定序列化后 SHA-256（hex）。源哈希相同 → 合并不重复投递 */
export function sourceHashOf(snapshot: Record<string, unknown>, sha256Hex: (s: string) => string): string {
  return sha256Hex(stableStringify(snapshot))
}

/** 全量核对窗口：sweep 查询使用的比赛时间范围（beginAt 在窗口内） */
export function sweepQuery(now: Date, lookbackDays: number): { beginAtStart: Date; beginAtEnd: Date } {
  const beginAtStart = new Date(now.getTime() - lookbackDays * 24 * 3600_000)
  const beginAtEnd = new Date(now.getTime() + 7 * 24 * 3600_000)
  return { beginAtStart, beginAtEnd }
}
