import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common'
import { WxPusherService } from './wxpusher.service.js'

/**
 * WxPusher 事件回调入口（公网可访问，不经 SessionGuard）：
 * - 在 WxPusher 管理后台将事件回调地址配置为 ${PUBLIC_BASE_URL}/api/v1/webhooks/wxpusher；
 * - 安全依赖服务端签发的短期一次性随机 extra 令牌，过期或伪造请求均被静默忽略。
 */
@Controller('/api/v1/webhooks/wxpusher')
export class WxPusherWebhookController {
  constructor(@Inject(WxPusherService) private readonly wxpusher: WxPusherService) {}

  @Get()
  health() {
    return { ok: true, configured: this.wxpusher.isConfigured() }
  }

  @Post()
  @HttpCode(200)
  async receive(@Body() body: unknown) {
    return this.wxpusher.handleWebhook(body)
  }
}
