import type { MongoCollection, MongoFindCursor, MongoSortSpec } from '../../src/mongo-types.js'

/**
 * 内存 MongoCollection mock：支持本插件用到的 filter 操作符
 * （等值/$lt/$lte/$gt/$gte/$in/$nin/$exists/$or/null）与更新操作符（$set/$setOnInsert）。
 * 仅用于 outbox/delivery/config 的纯逻辑测试；真实多进程租约语义以学校实例联调为准。
 */

type Doc = { _id: unknown; [key: string]: unknown }

function matchesValue(docValue: unknown, condition: unknown): boolean {
  if (condition === null) return docValue === null || docValue === undefined
  if (typeof condition === 'object' && condition !== null && !Array.isArray(condition) && !(condition instanceof Date)) {
    for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
      // Mongo 比较运算采用 BSON 类型约束，null 不能当成早于任意 Date。
      if (['$lt', '$lte', '$gt', '$gte'].includes(op) && operand instanceof Date && !(docValue instanceof Date)) return false
      switch (op) {
        case '$lt': if (!(compare(docValue, operand) < 0)) return false; break
        case '$lte': if (!(compare(docValue, operand) <= 0)) return false; break
        case '$gt': if (!(compare(docValue, operand) > 0)) return false; break
        case '$gte': if (!(compare(docValue, operand) >= 0)) return false; break
        case '$in': if (!(Array.isArray(operand) && operand.some((v) => compare(docValue, v) === 0))) return false; break
        case '$nin': if (Array.isArray(operand) && operand.some((v) => compare(docValue, v) === 0)) return false; break
        case '$exists': {
          const exists = docValue !== undefined
          if (Boolean(exists) !== Boolean(operand)) return false
          break
        }
        case '$ne': if (compare(docValue, operand) === 0) return false; break
        default: return false
      }
    }
    return true
  }
  return compare(docValue, condition) === 0
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (a === b) return 0
  if (a === undefined || a === null) return -1
  if (b === undefined || b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

export function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      const ok = (condition as Record<string, unknown>[]).some((sub) => matches(doc, sub))
      if (!ok) return false
      continue
    }
    if (key === '$and') {
      const ok = (condition as Record<string, unknown>[]).every((sub) => matches(doc, sub))
      if (!ok) return false
      continue
    }
    if (!matchesValue(doc[key], condition)) return false
  }
  return true
}

class MockCursor<T extends Doc> implements MongoFindCursor<T> {
  constructor(private docs: T[], private sortSpec?: MongoSortSpec, private limitN?: number, private skipN?: number) {}
  sort(spec: MongoSortSpec): MongoFindCursor<T> {
    return new MockCursor(this.docs, spec, this.limitN, this.skipN)
  }
  limit(n: number): MongoFindCursor<T> {
    return new MockCursor(this.docs, this.sortSpec, n, this.skipN)
  }
  skip(n: number): MongoFindCursor<T> {
    return new MockCursor(this.docs, this.sortSpec, this.limitN, n)
  }
  async toArray(): Promise<T[]> {
    let out = [...this.docs]
    if (this.sortSpec) {
      const entries = Object.entries(this.sortSpec)
      out.sort((x, y) => {
        for (const [key, dir] of entries) {
          const c = compare(x[key], y[key])
          if (c !== 0) return c * dir
        }
        return 0
      })
    }
    if (this.skipN) out = out.slice(this.skipN)
    if (this.limitN !== undefined) out = out.slice(0, this.limitN)
    return out
  }
}

export class MockCollection<T extends Doc> implements MongoCollection<T> {
  public docs: T[] = []
  public uniqueFields: string[][] = []
  private idSeq = 0

  constructor(initial: T[] = []) {
    this.docs = initial.map((d) => ({ ...d }))
  }

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }

  find(filter: Record<string, unknown> = {}, options?: { sort?: MongoSortSpec; limit?: number; skip?: number }): MongoFindCursor<T> {
    const docs = this.docs.filter((d) => matches(d, filter))
    return new MockCursor(docs, options?.sort, options?.limit, options?.skip)
  }

  async insertOne(doc: T): Promise<{ insertedId: unknown }> {
    for (const fields of this.uniqueFields) {
      const dup = this.docs.find((d) => fields.every((f) => compare(d[f], doc[f]) === 0))
      if (dup) {
        const error = new Error('E11000 duplicate key error') as Error & { code?: number }
        error.code = 11000
        throw error
      }
    }
    this.docs.push({ ...doc })
    return { insertedId: doc._id }
  }

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }> {
    const idx = this.docs.findIndex((d) => matches(d, filter))
    if (idx === -1) {
      if (options?.upsert) {
        const base = Object.fromEntries(Object.entries(filter).filter(([key, value]) => !key.startsWith('$') && (value === null || typeof value !== 'object')))
        const inserted = this.applyUpdate(base as T, update, true)
        this.docs.push(inserted)
        return { matchedCount: 1, modifiedCount: 0, upsertedId: inserted._id }
      }
      return { matchedCount: 0, modifiedCount: 0 }
    }
    this.docs[idx] = this.applyUpdate(this.docs[idx], update, false)
    return { matchedCount: 1, modifiedCount: 1 }
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: 'before' | 'after'; sort?: MongoSortSpec },
  ): Promise<{ ok: 1; value: T | null }> {
    const candidates = this.docs.map((d, i) => ({ d, i })).filter(({ d }) => matches(d, filter))
    if (!candidates.length) return { ok: 1, value: null }
    if (options?.sort) {
      const entries = Object.entries(options.sort)
      candidates.sort((x, y) => {
        for (const [key, dir] of entries) {
          const c = compare(x.d[key], y.d[key])
          if (c !== 0) return c * dir
        }
        return 0
      })
    }
    const target = candidates[0]
    const before = { ...target.d }
    this.docs[target.i] = this.applyUpdate(this.docs[target.i], update, false)
    return { ok: 1, value: (options?.returnDocument === 'before' ? before : this.docs[target.i]) as T }
  }

  async deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const before = this.docs.length
    this.docs = this.docs.filter((d) => !matches(d, filter))
    return { deletedCount: before - this.docs.length }
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }

  async createIndex(): Promise<string> {
    this.idSeq++
    return `idx_${this.idSeq}`
  }

  /** 声明唯一键（用于 eventId 幂等语义测试） */
  withUnique(...fields: string[]): this {
    this.uniqueFields.push(fields)
    return this
  }

  private applyUpdate(doc: T, update: Record<string, unknown>, isInsert: boolean): T {
    const out: Record<string, unknown> = { ...doc }
    const set = update.$set as Record<string, unknown> | undefined
    const setOnInsert = update.$setOnInsert as Record<string, unknown> | undefined
    const inc = update.$inc as Record<string, number> | undefined
    if (set) for (const [k, v] of Object.entries(set)) out[k] = v
    if (isInsert && setOnInsert) for (const [k, v] of Object.entries(setOnInsert)) if (out[k] === undefined) out[k] = v
    if (inc) for (const [k, v] of Object.entries(inc)) out[k] = Number(out[k] ?? 0) + v
    return out as T
  }
}
