import { Injectable, NestMiddleware } from '@nestjs/common'
import { runWithTenantSlot } from '@nova/tenancy'
import type { NextFunction, Request, Response } from 'express'

// 为每个请求建立“租户槽”（12.8）。身份解析完成后由 ContextService 绑定租户；
// 此后同一请求内的数据库访问都带着这个租户。必须在请求体解析之后建立，异步上下文才能一路传到业务代码。
@Injectable()
export class TenantSlotMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction) {
    runWithTenantSlot(() => next())
  }
}
