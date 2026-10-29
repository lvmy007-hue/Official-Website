import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import { PII_REVEAL_ACTION, PII_REVEAL_AUDIT_RESOURCE, PII_REVEAL_PERMISSION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PiiRevealService } from './pii-reveal.service'

// 个人信息统一出口（P6-14）：全站唯一返回个人信息明文的接口。响应带明文：sensitiveResponse 让幂等记录不保存响应内容，也不会被缓存。
// 被拒绝的请求（没有 field.buyer 权限等）由写接口拦截器按这里声明的动作写一条“被拒绝”审计；成功与“没有内容”由服务写审计。
@UseGuards(AuthGuard)
@Controller('pii')
export class PiiController {
  constructor(private readonly reveal: PiiRevealService) {}

  @Write({ action: PII_REVEAL_ACTION, resourceType: PII_REVEAL_AUDIT_RESOURCE, permission: PII_REVEAL_PERMISSION, sensitiveResponse: true })
  @HttpCode(200)
  @Post('reveal')
  async revealPii(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.reveal.reveal(req, body), req)
  }
}
