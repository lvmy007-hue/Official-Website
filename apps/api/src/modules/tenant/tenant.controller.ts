import { Controller, Get, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { TenantService } from './tenant.service'
@UseGuards(AuthGuard)
@Controller()
export class TenantController {
  constructor(private readonly tenant: TenantService) {}

  // 法律主体的接口在 modules/entities（P5-07），成员与角色的接口在 modules/members（P5-08）；这里只留范围栏可选项
  // 全局范围栏可选项：仅需登录，内容只含当前成员被授权的主体与店铺
  @Get('scope/options')
  async scopeOptions(@Req() req: RequestWithContext) {
    return ok(await this.tenant.scopeOptions(req), req)
  }
}
