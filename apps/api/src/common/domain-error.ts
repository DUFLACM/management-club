import { HttpException } from '@nestjs/common'

/** 可向客户端展示的业务拒绝，保留稳定错误码；运行时/数据库错误仍由过滤器隐藏。 */
export class DomainError extends HttpException {
  constructor(message: string, readonly code: string) {
    const status = code === 'NOT_FOUND' ? 404
      : ['CSRF_INVALID', 'ORIGIN_MISMATCH', 'ORIGIN_INVALID', 'RECUSED', 'FORBIDDEN'].includes(code) ? 403
        : 400
    super({ code, message }, status)
  }
}
