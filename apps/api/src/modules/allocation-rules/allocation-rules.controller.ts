import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ALLOCATION_RULE_ACTIONS, ALLOCATION_RULE_READ, ALLOCATION_RULE_WRITE } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AllocationRulesPreviewService } from './allocation-rules-preview.service'
import { AllocationRulesReadService } from './allocation-rules-read.service'
import { AllocationRulesWriteService } from './allocation-rules-write.service'

// 费用分摊规则（P6-19，freeze/api.md `/finance/allocation-rules*`）：读取需要 finance.read，新建与修改需要 finance.policy.write。
// 静态路径 preview 在前；预览用 POST 是冻结里的约定（规则放在请求体里），只读、不写审计，仍要幂等键。
@UseGuards(AuthGuard)
@Controller('finance/allocation-rules')
export class AllocationRulesController {
  constructor(
    private readonly reader: AllocationRulesReadService,
    private readonly writer: AllocationRulesWriteService,
    private readonly previewer: AllocationRulesPreviewService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reader.list(req, query), req)
  }

  @Write({ action: 'ALLOCATION_RULE_PREVIEWED', resourceType: 'AllocationRule', permission: ALLOCATION_RULE_READ, audit: false })
  @HttpCode(200)
  @Post('preview')
  async preview(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.previewer.preview(req, body), req)
  }

  @Write({ action: ALLOCATION_RULE_ACTIONS.created, resourceType: 'AllocationRule', permission: ALLOCATION_RULE_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.writer.create(req, body), req))
  }

  @Write({ action: ALLOCATION_RULE_ACTIONS.updated, resourceType: 'AllocationRule', permission: ALLOCATION_RULE_WRITE })
  @Put()
  async update(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writer.update(req, body), req)
  }
}
