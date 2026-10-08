import { randomBytes, randomInt, scrypt, timingSafeEqual, createHash } from 'node:crypto'

const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

/** 管理员自行设置的新密码长度区间（已有的更长初始密码照常可登录） */
export const ADMIN_PASSWORD_MIN_LENGTH = 6
export const ADMIN_PASSWORD_MAX_LENGTH = 18
/**
 * 入口密语是管理端登录的第一道门，不是第二个密码：真正的身份校验在用户名+密码+一次性验证码。
 * 短密语的暴力破解风险由 IP/账号维度限流兜底（15 分钟窗口内 5 次失败即封禁 15 分钟），
 * 因此下限取便于口头转交的 5 位；管理员密码另有 6–18 位规则。
 */
export const ADMIN_SECRET_MIN_LENGTH = 5

function derive(value: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      value,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, key) => error ? reject(error) : resolve(key as Buffer),
    )
  })
}

/** Versioned, salted slow hash suitable for local administrator passwords and the shared gate phrase. */
export async function hashAdminSecret(value: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(value, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyAdminSecret(value: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [n, r, p] = parts.slice(1, 4).map(Number)
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false
  const actual = await derive(value, salt)
  return timingSafeEqual(actual, expected)
}

/** 32 URL-safe characters with about 192 bits of entropy; shown only once by the CLI. */
export function generateInitialAdminSecret(): string {
  return randomBytes(24).toString('base64url')
}

export function normalizeAdminUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9._-]{3,64}$/.test(normalized) ? normalized : null
}

const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export function generateCaptcha(): { answer: string; svg: string } {
  let answer = ''
  for (let i = 0; i < 5; i += 1) answer += CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)]
  const glyphs = answer.split('').map((char, index) => {
    const x = 22 + index * 29 + randomInt(-2, 3)
    const y = 39 + randomInt(-3, 4)
    const rotation = randomInt(-16, 17)
    return `<text x="${x}" y="${y}" transform="rotate(${rotation} ${x} ${y})">${char}</text>`
  }).join('')
  const lines = Array.from({ length: 5 }, () => {
    const x1 = randomInt(0, 165)
    const y1 = randomInt(3, 53)
    const x2 = randomInt(0, 165)
    const y2 = randomInt(3, 53)
    return `<path d="M${x1} ${y1} L${x2} ${y2}"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="165" height="56" viewBox="0 0 165 56" role="img" aria-label="登录验证码"><rect width="165" height="56" rx="10" fill="#eef3ff"/><g stroke="#8ba0cf" stroke-width="1" opacity=".55">${lines}</g><g fill="#1c315f" font-family="ui-monospace,monospace" font-size="27" font-weight="700">${glyphs}</g></svg>`
  return { answer, svg }
}

export function hashOneTimeCode(challengeId: string, answer: string, salt = randomBytes(16).toString('base64url')): string {
  const digest = createHash('sha256').update(`${salt}:${challengeId}:${answer.trim().toUpperCase()}`).digest('base64url')
  return `sha256$${salt}$${digest}`
}

export function verifyOneTimeCode(challengeId: string, answer: string, encoded: string): boolean {
  const [algorithm, salt, expectedText] = encoded.split('$')
  if (algorithm !== 'sha256' || !salt || !expectedText) return false
  const actualText = hashOneTimeCode(challengeId, answer, salt).split('$')[2]
  const expected = Buffer.from(expectedText, 'base64url')
  const actual = Buffer.from(actualText, 'base64url')
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}
