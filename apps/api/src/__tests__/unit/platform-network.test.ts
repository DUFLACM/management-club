import { EventEmitter } from 'node:events'
import https from 'node:https'
import { gzipSync } from 'node:zlib'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { safeFetch } from '@acm/integrations'

const request = vi.spyOn(https, 'request')

afterAll(() => vi.restoreAllMocks())

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['127.0.0.1', '192.168.1.20', '198.18.2.93'])('平台固定地址仍拒绝私网与 fake-IP %s', async (address) => {
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', address)
  await expect(safeFetch('https://atcoder.jp/users/example/history/json', { allowedHosts: ['atcoder.jp'] }))
    .rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' })
  expect(request).not.toHaveBeenCalled()
})

it('固定地址必须是 IP，且不能扩大主机白名单', async () => {
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', 'somewhere.example')
  await expect(safeFetch('https://atcoder.jp/x', { allowedHosts: ['atcoder.jp'] }))
    .rejects.toMatchObject({ code: 'INVALID_CONNECT_ADDRESS' })
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', '3.169.173.52')
  await expect(safeFetch('https://atcoder.jp/x', { allowedHosts: ['codeforces.com'] }))
    .rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
  expect(request).not.toHaveBeenCalled()
})

function respond(statusCode: number, body: Buffer, headers: Record<string, string>) {
  vi.mocked(request).mockImplementation(((_url: URL, _options: unknown, callback: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void }
    req.destroy = (error) => { queueMicrotask(() => req.emit('error', error)) }
    req.end = () => {
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode, headers })
        callback(response)
        response.emit('data', body)
        response.emit('end')
      })
    }
    return req
  }) as never)
}

it('使用公网地址连接，仍按平台域名校验证书，并解压 JSON', async () => {
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', '3.169.173.52')
  respond(200, gzipSync(Buffer.from('[{"IsRated":true}]')), { 'content-type': 'application/json', 'content-encoding': 'gzip' })
  const result = await safeFetch('https://atcoder.jp/users/example/history/json', { allowedHosts: ['atcoder.jp'], expectContentTypes: ['application/json'] })
  expect(JSON.parse(result.text)).toEqual([{ IsRated: true }])
  const options = vi.mocked(request).mock.calls[0][1] as { servername: string; rejectUnauthorized: boolean; lookup: Function }
  expect(options).toMatchObject({ servername: 'atcoder.jp', rejectUnauthorized: true })
  const resolved = vi.fn()
  options.lookup('atcoder.jp', {}, resolved)
  expect(resolved).toHaveBeenCalledWith(null, '3.169.173.52', 4)
})

it('固定地址连接仍拒绝重定向', async () => {
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', '3.169.173.52')
  respond(302, Buffer.from('redirect'), { 'content-type': 'text/html', location: 'https://evil.example' })
  await expect(safeFetch('https://atcoder.jp/x', { allowedHosts: ['atcoder.jp'] }))
    .rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
})

it('压缩响应的解压大小仍受限制', async () => {
  vi.stubEnv('PLATFORM_ATCODER_ADDRESS', '3.169.173.52')
  respond(200, gzipSync(Buffer.from('x'.repeat(5000))), { 'content-type': 'application/json', 'content-encoding': 'gzip' })
  await expect(safeFetch('https://atcoder.jp/x', { allowedHosts: ['atcoder.jp'], maxBytes: 128 })).rejects.toThrow()
})
