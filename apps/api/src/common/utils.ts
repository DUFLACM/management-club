import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** Asia/Shanghai 业务时区：自然月/周规则一律由此推导，不依赖服务器时区 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function toShanghaiLocalParts(date: Date): { year: number; month: number; day: number; hour: number } {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  }
}

/** 自然月键 YYYY-MM（Asia/Shanghai） */
export function monthKey(date: Date): string {
  const p = toShanghaiLocalParts(date)
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

export function monthKeyPlus(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error(`bad month ${month}`)
  let y = Number(m[1])
  let mo = Number(m[2]) + delta
  while (mo > 12) { mo -= 12; y += 1 }
  while (mo < 1) { mo += 12; y -= 1 }
  return `${y}-${String(mo).padStart(2, '0')}`
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function newId(): string {
  return randomUUID()
}

/**
 * CAS 验真的校园编号（学号/工号）按 opaque 文本处理。
 * 不转数字、不改大小写，以保留前导零和校方原始语义。
 */
export function isValidCampusId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)
}

/** 兼容旧调用名；学生学号也使用可变长校园编号规则。 */
export const isValidStudentNo = isValidCampusId

/** Haversine 距离（米）——服务端统一围栏计算，WGS84 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 邀请码：12 位去混淆 Base32（手输码） */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 无 I L O 0 1

export function generateInviteCode(): string {
  const bytes = randomBytes(12)
  let out = ''
  for (let i = 0; i < 12; i++) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  return out
}

export function normalizeInviteCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[IL]/g, (c) => (c === 'I' ? '1' : '1')).replace(/O/g, '0')
  // 容错：把易混字符按输入习惯映射回字母表（0→不含；1→不含）——直接拒绝含 0/1 的码
  return cleaned
}

export function isValidInviteCodeFormat(input: string): boolean {
  return /^[A-HJ-KM-NP-Z2-9]{12}$/.test(input.trim().toUpperCase())
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * 成员对外显示名：展示名可自定义，后面括号带实名，如「Alice（张三）」；
 * 没设展示名或与实名相同时只显示实名。系统内凡是展示成员名称的接口都用它拼。
 */
export function memberName(user: { verifiedRealName: string | null; profile?: { displayName: string | null } | null }): string {
  const display = user.profile?.displayName?.trim() || null
  const real = user.verifiedRealName?.trim() || null
  if (display && real && display !== real) return `${display}（${real}）`
  return display ?? real ?? ''
}

/** 列表里可展示的头像：主页设为「仅自己」的成员不暴露头像（与头像读取接口的可见性口径一致） */
export function visibleAvatar(profile: { avatarAssetId: string | null; visibility: string } | null | undefined): string | null {
  if (!profile || profile.visibility === 'self_only') return null
  return profile.avatarAssetId
}
