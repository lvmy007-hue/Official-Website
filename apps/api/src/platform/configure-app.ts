import { INestApplication, ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import type { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { ApiExceptionFilter, requestIdMiddleware } from './http'
import type { Logger } from 'pino'
import { requestObserver } from './observability'
import { queryShapeGuard } from './query-shape'
import { parseTrustProxy } from './security/trust-proxy'

/** 请求体上限（P1-17）：接口只收小体量的 JSON；文件上传走专门的上传通道（P1-23），不受此项放宽。 */
export const REQUEST_BODY_LIMIT = '1mb'

// 接口响应的安全头：接口只返回 JSON，不需要加载任何资源，也不应被嵌入任何页面。
// 页面本身的内容安全策略由提供页面的网关设置（见 infrastructure 下的 nginx 配置）。
export const API_CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
} as const

// 请求体过大等由解析中间件抛出的错误，转成统一的错误响应，不暴露内部信息。
function bodyErrorHandler(error: { status?: number; type?: string } | undefined, req: Request, res: Response, next: NextFunction) {
  if (!error) return next()
  const tooLarge = error.type === 'entity.too.large' || error.status === 413
  const status = tooLarge ? 413 : error.status && error.status >= 400 && error.status < 500 ? error.status : 400
  const code = tooLarge ? 'REQUEST_BODY_TOO_LARGE' : 'BAD_REQUEST'
  const message = tooLarge ? `请求体超过 ${REQUEST_BODY_LIMIT} 上限` : '请求体格式不正确'
  const requestId = (req as Request & { requestId?: string }).requestId ?? 'unknown'
  res.status(status).json({ success: false, error: { code, message, requestId, retryable: false } })
}

// 应用级中间件与全局配置。启动入口与测试共用，保证测试环境与生产行为一致。
export function configureApp(app: INestApplication, log?: Logger) {
  const express = app as NestExpressApplication
  // 只信任我方网关，才能拿到真实客户端地址（限流、登录锁定、审计都依赖它）
  express.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))
  express.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: API_CSP_DIRECTIVES }, frameguard: { action: 'deny' }, referrerPolicy: { policy: 'no-referrer' } }))
  app.use(requestIdMiddleware)
  app.use(queryShapeGuard)
  // 认证接口的响应含令牌，任何缓存都不得保存
  app.use('/api/v1/auth', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  express.useBodyParser('json', { limit: REQUEST_BODY_LIMIT })
  express.useBodyParser('urlencoded', { limit: REQUEST_BODY_LIMIT, extended: true })
  app.use(bodyErrorHandler)
  app.use(cookieParser())
  app.use(requestObserver(log))
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
  app.enableCors({ origin: origins.length ? origins : false, credentials: true })
  app.setGlobalPrefix('api/v1')
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
  app.useGlobalFilters(new ApiExceptionFilter())
}
