/**
 * 插件用到的 MongoDB 最小结构类型（仅本包内部）。
 *
 * hydrooj 与 mongodb 都是 peer 运行时依赖（由学校实例提供），本包构建期不安装，
 * 因此这里声明与 mongodb driver 兼容的最小接口子集。真实类型以学校实例的
 * hydrooj / mongodb 版本为准（src/hydrooj-stubs.d.ts 同理）。
 */

export interface MongoObjectId {
  toHexString(): string
  getTimestamp(): Date
  equals(other: unknown): boolean
  toString(): string
}

export interface MongoSortSpec {
  [key: string]: 1 | -1
}

export interface MongoFindCursor<T> {
  sort(spec: MongoSortSpec): MongoFindCursor<T>
  limit(n: number): MongoFindCursor<T>
  skip(n: number): MongoFindCursor<T>
  toArray(): Promise<T[]>
}

export interface MongoUpdateResult {
  matchedCount: number
  modifiedCount: number
  upsertedId?: unknown
}

/** 与 mongodb driver 的 DuplicateKeyError 兼容的判定（v5/v6 均有 code=11000 或 name） */
export function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: number; name?: string; message?: string } | null
  if (!e) return false
  if (e.code === 11000) return true
  if (typeof e.message === 'string' && e.message.includes('E11000 duplicate key')) return true
  if (e.name === 'MongoServerError' && typeof e.message === 'string' && e.message.includes('duplicate key')) return true
  return false
}

/**
 * 插件使用的 collection 子集。真实运行时是 ctx.db.collection(name)（经 Hydro
 * MongoService 应用 prefix/collectionMap 后的 collection），测试中用内存 mock 实现。
 */
export interface MongoCollection<T extends { _id: unknown }> {
  findOne(filter: Record<string, unknown>): Promise<T | null>
  find(filter?: Record<string, unknown>, options?: { sort?: MongoSortSpec; limit?: number; skip?: number }): MongoFindCursor<T>
  insertOne(doc: T): Promise<{ insertedId: unknown }>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<MongoUpdateResult>
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: 'before' | 'after'; sort?: MongoSortSpec; includeResultMetadata?: false },
  ): Promise<T | { ok: 1; value: T | null } | null>
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>
  countDocuments(filter?: Record<string, unknown>): Promise<number>
  createIndex(keys: Record<string, 1 | -1>, options?: { name?: string; unique?: boolean; expireAfterSeconds?: number }): Promise<string>
}

/** MongoDB 6/7 默认直接返回文档；兼容仍返回 ModifyResult 的旧安装与测试替身。 */
export function updatedDocument<T extends { _id: unknown }>(result: T | { ok: 1; value: T | null } | null): T | null {
  if (result === null) return null
  if ('_id' in result) return result as T
  return result.value
}
