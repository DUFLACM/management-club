import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { HydroService, HydroError } from './hydro.service.js'

/**
 * Hydro Bridge webhook 机器接口：独立认证（IntegrationSignatureGuard 职责由服务内完成），
 * 不能以此建立学生登录会话；原始请求体在 JSON 解析前保留用于验签。
 */
@Controller('/api/v1/integrations/hydro')
export class HydroController {
  constructor(private readonly hydro: HydroService) {}

  @Post('events')
  @HttpCode(202)
  async events(@Req() req: Request, @Body() _body: unknown) {
    // 必须用原始 body 验签，禁止解析后重新 stringify
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(_body ?? {}))
    try {
      return await this.hydro.receiveWebhook(
        {
          keyId: req.headers['x-hydro-key-id'] as string | undefined,
          instanceId: req.headers['x-hydro-instance-id'] as string | undefined,
          timestamp: req.headers['x-hydro-timestamp'] as string | undefined,
          nonce: req.headers['x-hydro-nonce'] as string | undefined,
          signature: req.headers['x-hydro-signature'] as string | undefined,
        },
        raw,
      )
    } catch (e) {
      if (e instanceof HydroError) {
        return { error: { code: e.code, message: e.message } }
      }
      throw e
    }
  }
}
