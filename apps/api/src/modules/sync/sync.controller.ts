import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ParityService } from './parity.service'
import { SyncDetailService } from './sync-detail.service'
import { SyncListService } from './sync-list.service'
import { SyncMonitorService } from './sync-monitor.service'
import { SyncService } from './sync.service'

@UseGuards(AuthGuard)
@Controller()
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly parity: ParityService,
    private readonly list: SyncListService,
    private readonly detail: SyncDetailService,
    private readonly monitor: SyncMonitorService,
  ) {}

  @Get('sync/jobs')
  async jobs(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('sync/queues')
  async queues(@Req() req: RequestWithContext) {
    return ok(await this.monitor.queues(req), req)
  }

  @Get('sync/rate-limits')
  async rateLimits(@Req() req: RequestWithContext) {
    return ok(await this.monitor.rateLimits(req), req)
  }

  @Get('sync/parity')
  async parityReport(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.parity.report(req, query), req)
  }

  @Get('sync/dead-letters')
  async deadLetters(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.sync.deadLetters(req, query), req)
  }

  @Get('sync/jobs/:id')
  async jobDetail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.detail(req, id), req)
  }

  @Write({ action: 'SYNC_DEAD_LETTER_REPLAYED', resourceType: 'DeadLetterJob', permission: 'sync.manage' })
  @Post('sync/dead-letters/:id/replay')
  async replayDeadLetter(@Req() req: RequestWithContext, @Param('id') id: string, @Res() response: Response) {
    return response.status(202).json(ok(await this.sync.replayDeadLetter(req, id), req))
  }

  @Write({ action: 'SYNC_JOB_RETRIED', resourceType: 'SyncJob', permission: 'sync.manage' })
  @Post('sync/jobs/:id/retry')
  async retry(@Req() req: RequestWithContext, @Param('id') id: string, @Res() response: Response) {
    return response.status(202).json(ok(await this.sync.retry(req, id), req))
  }

  @Write({ action: 'SYNC_JOB_CREATED', resourceType: 'SyncJob', permission: 'sync.manage' })
  @Post('sync/jobs')
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(202).json(ok(await this.sync.create(req, body), req))
  }

  @Write({ action: 'ADS_SYNC_REQUESTED', resourceType: 'SyncJob', permission: 'sync.manage' })
  @Post('ads/sync')
  async createAds(@Req() req: RequestWithContext, @Res() response: Response) {
    return response.status(202).json(ok(await this.sync.createAds(req), req))
  }
}
