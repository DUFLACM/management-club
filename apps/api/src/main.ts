import { loadRuntimeEnvironment } from '@acm/db'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import { loadEnv, isDevSimulatorEnabled } from './config/env.js'
import { HttpException, type ArgumentsHost, type ExceptionFilter, Catch } from '@nestjs/common'
import type { Request, Response, NextFunction } from 'express'

/** 稳定错误包络：errorCode + message + requestId；不泄露堆栈/SQL/密钥 */
@Catch()
export class StableErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const status = exception instanceof HttpException ? exception.getStatus() : 500
    // multer 超限抛 413「File too large」：换成中文提示，避免前端显示英文 / 被当成服务器错误
    const body = status === 413
      ? { code: 'PAYLOAD_TOO_LARGE', message: '上传文件过大，请压缩后重试' }
      : exception instanceof HttpException ? exception.getResponse() : { message: '服务器内部错误' }
    const errorCode =
      typeof body === 'object' && body !== null && 'code' in body && typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 400
              ? 'BAD_REQUEST'
              : status === 404
                ? 'NOT_FOUND'
                : status < 500
                  ? 'REQUEST_FAILED'
                  : 'INTERNAL'
    res.status(status).json({
      error: {
        code: errorCode,
        message: typeof body === 'object' && body !== null && 'message' in body ? (body as { message: unknown }).message : '请求失败',
        requestId: crypto.randomUUID(),
      },
    })
  }
}

async function bootstrap(): Promise<void> {
  loadRuntimeEnvironment()
  const env = loadEnv()
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 保留原始请求体用于 Hydro webhook 验签（解析前字节）
    rawBody: true,
  })
  app.setGlobalPrefix('')
  // DTO 校验统一使用 zod（ZodValidationPipe/各控制器内 schema.parse），不使用 class-validator
  app.useGlobalFilters(new StableErrorFilter())

  // Cookie 解析 + 请求体限制 + Origin/基础安全头
  const cookieParser = (await import('cookie-parser')).default
  app.use(cookieParser())
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'private, no-store')
    next()
  })
  // 反代场景仅信任受控代理（生产部署在反代后开启）
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)

  app.enableCors({
    origin: [new URL(env.PUBLIC_BASE_URL).origin],
    credentials: true,
  })

  // OpenAPI（路径与响应结构由各控制器声明；DTO 校验为 zod，schema 细节以代码为准）
  const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger')
  const doc = new DocumentBuilder().setTitle('ACM 协会积分管理系统 API').setDescription('统一前缀 /api/v1；包络 {data, meta}；错误 {error:{code,message,requestId}}').setVersion('0.1').build()
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc))

  await app.listen(env.API_PORT, '127.0.0.1')
  const mode = isDevSimulatorEnabled(env) ? '[CAS 模拟模式 · 仅开发]' : '[真实 CAS 配置]'
  // eslint-disable-next-line no-console
  console.log(`ACM 俱乐部 API 已启动: http://127.0.0.1:${env.API_PORT} ${mode} CAS=${env.CAS_BASE_URL}`)
}
void bootstrap()
