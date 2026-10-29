import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_READ, ADS_WRITE_SUBMITTED_ACTION, type AdsWriteKind } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsBulkAddService } from './ads-bulk-add.service'
import { AdsWriteService } from './ads-write.service'
import { AdsWriteStatusService } from './ads-write-status.service'

// 广告写入（P3-17，freeze/api.md /ads/preview 与各写入口）：统一的写前预览、写入状态与记录、各对象的写入入口。
// 所有入口都进同一条流水线（AdsWriteService.submit）：权限 → 参数 → 对象与范围 → 动作守卫（权限、连接、开关）→ 写入记录与审计 → 后台任务调用亚马逊。
// 装饰器上的权限只是预检（登录且有广告读取权限）；每类写入自己的权限在服务里按请求内容逐项校验，先于参数校验。
const onlyKinds = (prefix: string) => ({ allow: (kind: AdsWriteKind) => kind.startsWith(prefix) })
const ACTION = { action: ADS_WRITE_SUBMITTED_ACTION, resourceType: 'AdsWriteRun', permission: ADS_READ }

/** 路径里的对象编号并进请求体（路径优先，防止请求体里再给一个不同的编号）。 */
const withId = (body: unknown, entityId: string) => ({ ops: [{ ...(body && typeof body === 'object' ? body : {}), entityId }] })

@UseGuards(AuthGuard)
@Controller('ads')
export class AdsWriteController {
  constructor(
    private readonly writes: AdsWriteService,
    private readonly status: AdsWriteStatusService,
    private readonly bulk: AdsBulkAddService,
  ) {}

  // 预览用 POST 是冻结里的约定；它只读、不改任何数据，所以不写审计（但仍要幂等键，和其他 POST 一致）。
  @Write({ action: 'ADS_WRITE_PREVIEWED', resourceType: 'AdsWriteRun', permission: ADS_READ, audit: false })
  @HttpCode(200)
  @Post('preview')
  async preview(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.preview(req, body), req)
  }

  @Get('writes')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.status.status(req, query), req)
  }

  @Write(ACTION)
  @Patch('campaigns')
  async campaigns(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.submit(req, body, onlyKinds('CAMPAIGN_')), req)
  }

  @Write(ACTION)
  @Patch('ad-groups/:id')
  async adGroup(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.submit(req, withId(body, id), onlyKinds('AD_GROUP_')), req)
  }

  @Write(ACTION)
  @Patch('targets/:id')
  async target(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.submit(req, withId(body, id), onlyKinds('TARGET_')), req)
  }

  @Write(ACTION)
  @HttpCode(200)
  @Post('negatives')
  async negative(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.submit(req, { ops: [{ ...(body && typeof body === 'object' ? body : {}), kind: 'NEGATIVE_ADD' }] }, onlyKinds('NEGATIVE_')), req)
  }

  // 词研究一键加词的批量入口（P6-24）：先去掉已有词与批内重复，其余逐项进同一条流水线；静态路径，写在 keywords 之后也不会冲突
  @Write(ACTION)
  @HttpCode(200)
  @Post('keywords/bulk-add')
  async bulkAdd(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.bulk.submit(req, body), req)
  }

  @Write(ACTION)
  @HttpCode(200)
  @Post('keywords')
  async keyword(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.submit(req, { ops: [{ ...(body && typeof body === 'object' ? body : {}), kind: 'KEYWORD_ADD' }] }, onlyKinds('KEYWORD_')), req)
  }
}
