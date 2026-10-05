import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseNowcoderHistoryPage, normalizeAtCoderContestId } from '@acm/integrations'
import { parseCasResponse } from '../../modules/auth/cas.client.js'
import { evaluateGeoFence } from '../../modules/attendance/attendance.service.js'
import { safeFetch } from '../../infrastructure/http/safe-fetch.js'

/** 平台契约测试：牛客真实响应摘录 / AtCoder 归一化 / CAS XML / 围栏判定 / SSRF 防护 */

const nowcoderSample = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/nowcoder-sample.json'), 'utf8'))

describe('牛客参赛历史契约（真实响应摘录）', () => {
  it('code=0 且 pageInfo 完整解析；毫秒时间与毫秒时长正确转换', () => {
    const page = parseNowcoderHistoryPage(nowcoderSample)
    expect(page.pageCurrent).toBe(1)
    expect(page.pageCount).toBe(2)
    expect(page.elementCount).toBe(16)
    expect(page.records).toHaveLength(1)
    const rec = page.records[0]
    expect(rec.externalContestId).toBe('140235')
    expect(rec.rank).toBe(370)
    expect(rec.canShowRank).toBe(true)
    expect(rec.signUpCount).toBe(1202) // 报名数 ≠ 有效排名人数，分别保存
    expect(rec.userCount).toBe(898)
    expect(rec.acceptedCount).toBe(3)
    expect(rec.problemCount).toBe(6)
    expect(rec.fullScore).toBe(1050)
    expect(rec.rating).toBe(989)
    expect(rec.participationType).toBe('OFFICIAL')
    expect(rec.startTime).toEqual(new Date(1789297200000)) // 毫秒
    expect(rec.durationSeconds).toBe(7200) // 7200000ms → 2h（不误当秒）
  })

  it('code != 0 抛业务错误（HTTP 200 也必须检查业务状态）', () => {
    expect(() => parseNowcoderHistoryPage({ code: 500, msg: 'NOLOGIN' })).toThrowError(/code=500/)
  })

  it('fullScore=0 视为未知（null，禁止除零）', () => {
    const page = parseNowcoderHistoryPage({
      code: 0,
      data: { dataList: [{ contestId: 1, startTime: 1, endTime: 2, fullScore: 0, totalScore: 5 }], pageInfo: { pageCount: 1, pageCurrent: 1, elementCount: 1 } },
    })
    expect(page.records[0].fullScore).toBeNull()
  })
})

describe('AtCoder ContestScreenName 归一化', () => {
  it('agc004.contest.atcoder.jp → agc004；保留原始值于 raw', () => {
    expect(normalizeAtCoderContestId('agc004.contest.atcoder.jp')).toBe('agc004')
    expect(normalizeAtCoderContestId('abc301')).toBe('abc301')
    expect(normalizeAtCoderContestId('Some_Odd_Format!')).toBe('Some_Odd_Format!') // 保留待人工
  })
})

describe('CAS XML 解析（attribute 键值数组与平铺两种形态）', () => {
  const subjectXml = (body: string) => Buffer.from(body).toString()

  it('解析 attribute 数组形态（参考 hydrooj-oauth-dlufl 的契约）', () => {
    const xml = subjectXml(`<?xml version="1.0"?>
<sso:serviceResponse xmlns:sso="https://www.yale.edu/tp/cas">
  <sso:authenticationSuccess>
    <sso:user>dev-202600001</sso:user>
    <sso:attributes>
      <sso:attribute name="user_id" value="u-12345"/>
      <sso:attribute name="id_number" value="202600001"/>
      <sso:attribute name="user_name" value="林同学"/>
    </sso:attributes>
  </sso:authenticationSuccess>
</sso:serviceResponse>`)
    const identity = parseCasResponse(xml)
    expect(identity.subject).toBe('u-12345')
    expect(identity.campusId).toBe('202600001')
    expect(identity.realName).toBe('林同学')
  })

  it('解析平铺形态', () => {
    const xml = subjectXml(`<cas:serviceResponse><cas:authenticationSuccess><cas:user>x</cas:user><cas:attributes><user_id>s1</user_id><id_number>001234567</id_number></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>`)
    const identity = parseCasResponse(xml)
    expect(identity.subject).toBe('s1')
    expect(identity.campusId).toBe('001234567') // 前导零
  })

  it('authenticationFailure 抛错；可变长校园编号保持文本', () => {
    expect(() => parseCasResponse('<sso:serviceResponse><sso:authenticationFailure code="INVALID_TICKET">bad</sso:authenticationFailure></sso:serviceResponse>')).toThrowError(/CAS 认证失败/)
    const identity = parseCasResponse('<sso:serviceResponse><sso:authenticationSuccess><sso:user>u</sso:user><sso:attributes><user_id>u2</user_id><id_number>12345</id_number></sso:attributes></sso:authenticationSuccess></sso:serviceResponse>')
    expect(identity.campusId).toBe('12345')
    expect(identity.subject).toBe('u2')
  })

  it('兼容带命名空间的平铺属性，保留校园编号前导零', () => {
    const identity = parseCasResponse('<cas:serviceResponse><cas:authenticationSuccess><cas:user>mutable-login-name</cas:user><cas:attributes><cas:user_id>stable-001</cas:user_id><cas:id_number>001234567</cas:id_number><cas:user_name>测试同学</cas:user_name></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>')
    expect(identity).toMatchObject({ subject: 'stable-001', campusId: '001234567', realName: '测试同学' })
  })

  it('接受字母/分隔符工号，拒绝空白、控制字符与超长编号', () => {
    const make = (id: string) => `<cas:serviceResponse><cas:authenticationSuccess><cas:attributes><user_id>s-${id.length}</user_id><id_number>${id}</id_number></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>`
    expect(parseCasResponse(make('T-001.A')).campusId).toBe('T-001.A')
    expect(parseCasResponse(make('bad value')).campusId).toBeNull()
    expect(parseCasResponse(make('A'.repeat(65))).campusId).toBeNull()
  })

  it('缺少配置稳定主体时拒绝，不能把登录名替代 user_id', () => {
    expect(() => parseCasResponse('<cas:serviceResponse><cas:authenticationSuccess><cas:user>mutable-login-name</cas:user><cas:attributes><id_number>202600001</id_number></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>')).toThrowError(/缺少稳定主体/)
  })

  it('拒绝 DTD 与实体声明，不能借 XML 实体扩展绕过响应大小限制', () => {
    expect(() => parseCasResponse('<!DOCTYPE x [<!ENTITY value "student">]><cas:serviceResponse/>')).toThrowError(/禁止的 XML 声明/)
  })
})

describe('围栏判定（保守规则）', () => {
  const center = { lat: 39.9, lng: 116.4 }
  const near = (meters: number) => {
    const dLat = meters / 111_320
    return { latitude: center.lat + dLat, longitude: center.lng }
  }
  it('d+accuracy≤R 自动通过；d−a>R 拒绝；边界/低精度待复核', () => {
    const ok = evaluateGeoFence(near(30).latitude, center.lng, 20, center.lat, center.lng, 60, 50)
    expect(ok.accepted).toBe(true)
    const outside = evaluateGeoFence(near(200).latitude, center.lng, 20, center.lat, center.lng, 60, 50)
    expect(outside.accepted).toBe(false)
    expect(outside.code).toBe('GEO_OUTSIDE')
    const boundary = evaluateGeoFence(near(50).latitude, center.lng, 20, center.lat, center.lng, 60, 50) // d=50, a=20 → 70>60, 30<60 边界
    expect(boundary.pending).toBe(true)
    const sloppy = evaluateGeoFence(center.lat, center.lng, 120, center.lat, center.lng, 60, 50)
    expect(sloppy.code).toBe('GEO_INACCURATE')
  })
})

describe('出站 SSRF 防护（不发起真实网络请求的错误路径）', () => {
  it('非白名单主机/非 HTTPS/非 443 端口被拒', async () => {
    await expect(safeFetch('https://evil.example.com/x', { allowedHosts: ['ac.nowcoder.com'] })).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    await expect(safeFetch('http://ac.nowcoder.com/x', { allowedHosts: ['ac.nowcoder.com'] })).rejects.toMatchObject({ code: 'SCHEME_NOT_ALLOWED' })
    await expect(safeFetch('https://ac.nowcoder.com:8443/x', { allowedHosts: ['ac.nowcoder.com'] })).rejects.toMatchObject({ code: 'PORT_NOT_ALLOWED' })
  })

  it.each(['127.0.0.1', '192.168.1.20', '198.18.2.169'])('固定解析仍拒绝私网或保留段 %s', async (connectAddress) => {
    await expect(safeFetch('https://cas.dlufl.edu.cn/cas/proxyValidate', { allowedHosts: ['cas.dlufl.edu.cn'], connectAddress })).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' })
  })
})
