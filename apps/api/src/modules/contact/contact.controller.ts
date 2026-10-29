import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ContactRequestSchema } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { RateLimitService } from '../../platform/rate-limit.service'
import { Write, WriteExempt } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ContactService } from './contact.service'

@Controller('contact-requests')
export class ContactController {
  constructor(
    private readonly contact: ContactService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @WriteExempt('官网公开表单：访客没有登录态，按来源地址限流并带蜜罐字段')
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    const input = ContactRequestSchema.parse(body)
    await this.rateLimit.check('contact', req.ip ?? 'unknown', 5, 300)
    return ok(await this.contact.create(input), req)
  }

  @UseGuards(AuthGuard)
  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.contact.list(req, query), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'CONTACT_REQUEST_STATUS_CHANGED', resourceType: 'ContactRequest', permission: 'connection.manage' })
  @Patch(':id')
  async updateStatus(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: { status?: string }) {
    return ok(await this.contact.updateStatus(req, id, String(body.status ?? '')), req)
  }
}
