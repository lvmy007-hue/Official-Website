import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { FreshnessService } from './freshness.service'

@UseGuards(AuthGuard)
@Controller('freshness')
export class FreshnessController {
  constructor(private readonly freshness: FreshnessService) {}

  @Get()
  async get(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.freshness.get(req, query), req)
  }
}
