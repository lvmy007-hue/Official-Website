import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { REIMBURSEMENTS_READ, REIMBURSEMENTS_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AttachmentService } from '../procurement'
import { ReimbursementsCaseService } from './reimbursements-case.service'
import { ReimbursementsDetailService } from './reimbursements-detail.service'
import { ReimbursementsEvidenceService } from './reimbursements-evidence.service'
import { ReimbursementsListService } from './reimbursements-list.service'
import { ReimbursementsStatsService } from './reimbursements-stats.service'

const CASE = 'ReimbursementCase'
const OPPORTUNITY = 'ReimbursementOpportunity'
const TYPE = 'REIMBURSEMENT_CASE'

// 赔付中心（P2b-03，07 章 7.3；freeze/api.md /reimbursements*）。静态路径（opportunities、stats）必须写在 :id 之前。
// 冻结表之外新增：机会的忽略与恢复、案件证据附件（复用采购模块的签名直传）。
@UseGuards(AuthGuard)
@Controller('reimbursements')
export class ReimbursementsController {
  constructor(
    private readonly lists: ReimbursementsListService,
    private readonly details: ReimbursementsDetailService,
    private readonly cases: ReimbursementsCaseService,
    private readonly evidence: ReimbursementsEvidenceService,
    private readonly statsService: ReimbursementsStatsService,
    private readonly attachments: AttachmentService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.cases(req, query), req)
  }

  @Get('opportunities')
  async opportunities(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.opportunities(req, query), req)
  }

  @Get('stats')
  async stats(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.statsService.stats(req, query), req)
  }

  @Write({ action: 'REIMBURSEMENT_CASE_CREATED', resourceType: CASE, permission: REIMBURSEMENTS_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.cases.create(req, body), req)
  }

  @Write({ action: 'REIMBURSEMENT_OPPORTUNITY_IGNORED', resourceType: OPPORTUNITY, permission: REIMBURSEMENTS_WRITE })
  @Post('opportunities/:id/ignore')
  async ignore(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.cases.ignore(req, id, body), req)
  }

  @Write({ action: 'REIMBURSEMENT_OPPORTUNITY_RESTORED', resourceType: OPPORTUNITY, permission: REIMBURSEMENTS_WRITE })
  @Post('opportunities/:id/restore')
  async restore(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.cases.restore(req, id, body), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: 'REIMBURSEMENT_CASE_UPDATED', resourceType: CASE, permission: REIMBURSEMENTS_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.cases.update(req, id, body), req)
  }

  @Write({ action: 'REIMBURSEMENT_EVIDENCE_PACK_CREATED', resourceType: CASE, permission: REIMBURSEMENTS_WRITE })
  @Post(':id/evidence-pack')
  async evidencePack(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.evidence.generate(req, id), req)
  }

  @Write({ action: 'ATTACHMENT_UPLOAD_REQUESTED', resourceType: CASE, permission: REIMBURSEMENTS_WRITE, audit: false })
  @Post(':id/attachments')
  async attachmentTicket(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    await this.evidence.assertCaseInScope(req, id, REIMBURSEMENTS_WRITE)
    return ok(await this.attachments.ticket(req, TYPE, id, body), req)
  }

  @Write({ action: 'ATTACHMENT_ADDED', resourceType: CASE, permission: REIMBURSEMENTS_WRITE })
  @Post(':id/attachments/confirm')
  async attachmentConfirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    await this.evidence.assertCaseInScope(req, id, REIMBURSEMENTS_WRITE)
    return ok(await this.attachments.confirm(req, TYPE, id, body), req)
  }

  @Get(':id/attachments/:attachmentId/download')
  async attachmentDownload(@Req() req: RequestWithContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    await this.evidence.assertCaseInScope(req, id, REIMBURSEMENTS_READ)
    return ok(await this.attachments.download(req, TYPE, id, attachmentId), req)
  }
}
