import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { PERIOD_CLOSE, PERIOD_REOPEN } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PeriodsCloseService } from './periods-close.service'
import { PeriodsReadService } from './periods-read.service'
import { PeriodsWriteService } from './periods-write.service'

// 期间关账（P2b-13，07 章 7.12；freeze/api.md /finance/periods*）。
// 锁定与重新开账要求再次验证身份（12 章 12.9）：冻结表里“锁定”一行没有标再次验证，这里按 12.9 收紧，见 CR-051。
@UseGuards(AuthGuard)
@Controller('finance/periods')
export class PeriodsController {
  constructor(
    private readonly reads: PeriodsReadService,
    private readonly writes: PeriodsWriteService,
    private readonly closes: PeriodsCloseService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.list(req, query), req)
  }

  @Write({ action: 'PERIOD_CREATED', resourceType: 'AccountingPeriod', permission: PERIOD_CLOSE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.reads.detail(req, id), req)
  }

  @Write({ action: 'PERIOD_CHECKED', resourceType: 'AccountingPeriod', permission: PERIOD_CLOSE })
  @Post(':id/check')
  async check(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.check(req, id, body), req)
  }

  @Write({ action: 'PERIOD_APPROVED', resourceType: 'AccountingPeriod', permission: PERIOD_CLOSE })
  @Post(':id/approve')
  async approve(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.approve(req, id, body), req)
  }

  @Write({ action: 'PERIOD_CLOSED', resourceType: 'AccountingPeriod', permission: PERIOD_CLOSE, stepUp: 'finance.period.close' })
  @Post(':id/close')
  async close(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.closes.close(req, id, body), req)
  }

  @Write({ action: 'PERIOD_REOPENED', resourceType: 'AccountingPeriod', permission: PERIOD_REOPEN, stepUp: 'finance.period.reopen' })
  @Post(':id/reopen')
  async reopen(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.closes.reopen(req, id, body), req)
  }
}
