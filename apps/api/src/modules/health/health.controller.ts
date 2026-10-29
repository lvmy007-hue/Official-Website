import { Controller, Get, Req } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { HealthService } from './health.service'

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(@Req() req: RequestWithContext) {
    return ok(await this.health.check(), req)
  }
}
