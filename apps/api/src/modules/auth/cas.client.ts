import { DomainError } from '../../common/domain-error.js'
import { XMLParser } from 'fast-xml-parser'
import { loadEnv } from '../../config/env.js'
import { safeFetch } from '../../infrastructure/http/safe-fetch.js'
import { isValidCampusId } from '../../common/utils.js'

/**
 * 学校 CAS 客户端（03 方案 2，参考 hydrooj-oauth-dlufl @3cbeead 的已核验行为）：
 * - POST service + ticket 到 CAS_VALIDATE_PATH，读取 sso:serviceResponse / authenticationSuccess / attributes。
 * - 底层是 CAS Service Ticket，不是 OAuth2 授权码。
 * - 只允许访问配置的 CAS 主机；TLS 校验开启；禁用 DTD/外部实体；响应大小与超时受限。
 * - 字段契约（id_number/user_name/user_id）须与校方真实响应联调确认；未确认前不猜 id_type 含义。
 */

export interface CasIdentity {
  subject: string // 稳定主体（如 user_id）
  campusId: string | null // CAS 验真的 opaque 校园编号，保留前导零
  realName: string | null
  rawAttributes: Record<string, unknown>
}

export class CasValidationError extends DomainError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message, code)
  }
}

const casHosts = (): string[] => [new URL(loadEnv().CAS_BASE_URL).hostname]

export function buildCasLoginUrl(service: string, renew = false): string {
  const env = loadEnv()
  const url = new URL(env.CAS_BASE_URL + env.CAS_LOGIN_PATH)
  url.searchParams.set('service', service)
  if (renew) url.searchParams.set('renew', 'true')
  return url.toString()
}

export function buildCasLogoutUrl(service?: string): string {
  const env = loadEnv()
  const url = new URL(env.CAS_BASE_URL + env.CAS_LOGOUT_PATH)
  if (service) url.searchParams.set('service', service)
  return url.toString()
}

/** 用数据库中保存的完整精确 service 验票（不能收前端传来的 service） */
export async function validateCasTicket(ticket: string, service: string): Promise<CasIdentity> {
  const env = loadEnv()
  const url = new URL(env.CAS_BASE_URL + env.CAS_VALIDATE_PATH)
  // proxyValidate 为 POST（参考实现），使用表单体
  const body = new URLSearchParams({ service, ticket }).toString()

  const res = await safeFetch(url.toString(), {
    allowedHosts: casHosts(),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    expectContentTypes: ['text/xml', 'application/xml'],
    maxBytes: 256 * 1024,
    timeoutMs: 12000,
    connectAddress: env.CAS_VALIDATE_ADDRESS,
  })
  if (res.status !== 200) {
    throw new CasValidationError(`CAS 校验 HTTP ${res.status}`, 'CAS_HTTP_ERROR')
  }
  return parseCasResponse(res.text)
}

/** 解析 CAS XML（禁 DTD/外部实性的 fast-xml-parser 默认安全；显式声明） */
export function parseCasResponse(xml: string): CasIdentity {
  const env = loadEnv()
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new CasValidationError('CAS 响应包含禁止的 XML 声明', 'CAS_XML_INVALID')
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // 关键：不把标签值转数字——学号 001234567 的前导零必须保留为字符串
    parseTagValue: false,
    parseAttributeValue: false,
    // 不解析 DTD / 外部实体（fast-xml-parser 默认不处理 DOCTYPE 声明体）
    processEntities: true,
  })
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch {
    throw new CasValidationError('CAS 响应 XML 解析失败', 'CAS_XML_INVALID')
  }
  const envelope = (doc['sso:serviceResponse'] ?? doc['cas:serviceResponse'] ?? doc.serviceResponse) as
    | Record<string, unknown>
    | undefined
  if (!envelope) throw new CasValidationError('CAS 响应缺少 serviceResponse', 'CAS_XML_INVALID')
  const failure = envelope['cas:authenticationFailure'] ?? envelope['sso:authenticationFailure'] ?? envelope.authenticationFailure
  if (failure != null) {
    throw new CasValidationError(`CAS 认证失败: ${String(typeof failure === 'object' ? JSON.stringify(failure) : failure)}`, 'CAS_AUTH_FAILURE')
  }
  const success = (envelope['cas:authenticationSuccess'] ?? envelope['sso:authenticationSuccess'] ?? envelope.authenticationSuccess) as
    | Record<string, unknown>
    | undefined
  if (!success) throw new CasValidationError('CAS 响应无 authenticationSuccess', 'CAS_AUTH_FAILURE')

  const rawAttributes = extractAttributes(success)
  const subjectRaw = pickAttribute(rawAttributes, env.CAS_STABLE_SUBJECT_ATTRIBUTE)
  const subject = typeof subjectRaw === 'string' && subjectRaw.trim() ? subjectRaw.trim() : ''
  if (!subject) throw new CasValidationError('CAS 响应缺少稳定主体属性', 'CAS_CONTRACT_MISSING')

  const campusIdRaw = pickAttribute(rawAttributes, env.CAS_STUDENT_NO_ATTRIBUTE)
  const campusId = typeof campusIdRaw === 'string' && isValidCampusId(campusIdRaw) ? campusIdRaw : null
  const realNameRaw = pickAttribute(rawAttributes, env.CAS_REAL_NAME_ATTRIBUTE)
  const realName = typeof realNameRaw === 'string' && realNameRaw.trim() ? realNameRaw.trim() : null
  return { subject, campusId, realName, rawAttributes }
}

function extractAttributes(success: Record<string, unknown>): Record<string, unknown> {
  const raw = (success['cas:attributes'] ?? success['sso:attributes'] ?? success.attributes) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return {}
  const attrs: Record<string, unknown> = {}
  // 属性形如 { 'cas:attribute' | 'sso:attribute' | attribute: [{ name, value }, ...] } 或平铺对象
  const attribute = pickField(raw, 'attribute')
  if (Array.isArray(attribute)) {
    for (const a of attribute) {
      const obj = a as Record<string, unknown>
      const name = obj['@_name'] ?? obj.name
      const value = obj['@_value'] ?? obj.value
      if (typeof name === 'string') attrs[name] = value
    }
  } else if (attribute && typeof attribute === 'object') {
    const obj = attribute as Record<string, unknown>
    const name = obj['@_name'] ?? obj.name
    if (typeof name === 'string') attrs[name] = obj['@_value'] ?? obj.value
  }
  // 平铺形式（各 CAS 版本差异）：合并非 attribute 键
  for (const [k, v] of Object.entries(raw)) {
    if (!/(^|:)attribute$/.test(k) && !(k in attrs)) attrs[k] = v
  }
  return attrs
}

/** 容错取带命名空间前缀的字段（user/attribute 等） */
function pickField(obj: Record<string, unknown>, name: string): unknown {
  if (name in obj) return obj[name]
  for (const key of Object.keys(obj)) {
    if (key.endsWith(`:${name}`)) return obj[key]
  }
  return undefined
}

function pickAttribute(attrs: Record<string, unknown>, name: string): unknown {
  const exact = pickField(attrs, name)
  if (exact !== undefined) return exact
  // 大小写容错（真实契约联调后固定）
  const key = Object.keys(attrs).find((k) => k.split(':').at(-1)?.toLowerCase() === name.toLowerCase())
  return key ? attrs[key] : undefined
}
