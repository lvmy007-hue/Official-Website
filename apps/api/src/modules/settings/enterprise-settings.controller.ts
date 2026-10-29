import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common'
import { SETTINGS_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { EnterpriseSettingsReadService } from './enterprise-settings-read.service'
import { EnterpriseSettingsWriteService } from './enterprise-settings-write.service'

// 企业设置（P5-10，09 章 9.12；freeze/api.md GET、PATCH /settings）。基本信息、数据保留、刷新策略可改；
// 风险规则版本只给摘要（规则在预警中心修改），内部访问模式由部署配置控制，只读展示。
@UseGuards(AuthGuard)
@Controller('settings')
export class EnterpriseSettingsController {
  constructor(
    private readonly reads: EnterpriseSettingsReadService,
    private readonly writes: EnterpriseSettingsWriteService,
  ) {}

  @Get()
  async get(@Req() req: RequestWithContext) {
    return ok(await this.reads.get(req), req)
  }

  @Write({ action: 'TENANT_SETTING_UPDATED', resourceType: 'TenantSetting', permission: SETTINGS_WRITE })
  @Patch()
  async update(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.update(req, body), req)
  }
}
