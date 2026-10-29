import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ListingPerfService } from './listing-perf.service'
import { ListingQualityService } from './listing-quality.service'
import { ListingWriteService } from './listing-write.service'

// 刊登（P4-09 表现、P4-10 质量与合规）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 写入类接口只“受理”：校验预览与刊登限制查询只读；修改刊登与批量任务依次通过 权限 → 店铺连接 → 写入开关（sw.listing.update、sw.feeds.batch）。
@UseGuards(AuthGuard)
@Controller('listings')
export class ListingsController {
  constructor(
    private readonly performance: ListingPerfService,
    private readonly quality: ListingQualityService,
    private readonly writes: ListingWriteService,
  ) {}

  // 刊登表现（P4-09，05 章 5.3）：只读，权限 listing.read。
  @Get('performance')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.performance.performance(req, query), req)
  }

  // 刊登质量（P4-10，05 章 5.4）：七个页签，权限 listing.read。
  @Get('quality')
  async qualityList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.quality.quality(req, query), req)
  }

  @Get('runs')
  async runs(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.writes.runs(req, query), req)
  }

  @Get('runs/:id')
  async run(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.writes.run(req, id), req)
  }

  @Write({ action: 'LISTING_VALIDATE_REQUESTED', resourceType: 'ListingWriteRun', permission: 'listing.write' })
  @Post('validate')
  async validate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.validate(req, body), req)
  }

  @Write({ action: 'LISTING_PATCH_SUBMITTED', resourceType: 'ListingWriteRun', permission: 'listing.write' })
  @Post('patch')
  async patch(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.patch(req, body), req)
  }

  @Write({ action: 'LISTING_BATCH_SUBMITTED', resourceType: 'ListingWriteRun', permission: 'listing.write' })
  @Post('batch')
  async batch(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.batch(req, body), req)
  }

  @Write({ action: 'LISTING_RESTRICTIONS_REQUESTED', resourceType: 'ListingWriteRun', permission: 'listing.read' })
  @Post('restrictions')
  async restrictions(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.restrictions(req, body), req)
  }
}
