import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { APLUS_ACTIONS, APLUS_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AplusDetailService } from './aplus-detail.service'
import { AplusReadService } from './aplus-read.service'
import { AplusUploadService } from './aplus-upload.service'
import { AplusWriteService } from './aplus-write.service'

// A+ 内容（P4-14；05 章 5.8；freeze/api.md /aplus*）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 静态路径（uploads、uploads/confirm）必须在 :id 之前注册，否则会被当成内容编号。读取权限 aplus.read；写入权限 aplus.write，并受写入开关“A+ 内容提交”控制。
// 写入类接口只“受理”：登记写入记录与后台任务，由后台任务调用亚马逊，结果在内容详情的“写入记录”里看。
@UseGuards(AuthGuard)
@Controller('aplus')
export class AplusController {
  constructor(
    private readonly reads: AplusReadService,
    private readonly details: AplusDetailService,
    private readonly uploads: AplusUploadService,
    private readonly writes: AplusWriteService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.list(req, query), req)
  }

  @Get('uploads')
  async uploadList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.uploads(req, query), req)
  }

  @Write({ action: 'APLUS_UPLOAD_TICKET_ISSUED', resourceType: 'AplusWriteRun', permission: APLUS_WRITE, audit: false })
  @Post('uploads')
  async uploadTicket(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.uploads.ticket(req, body), req)
  }

  @Write({ action: APLUS_ACTIONS.imageUploaded, resourceType: 'AplusWriteRun', permission: APLUS_WRITE })
  @Post('uploads/confirm')
  async uploadConfirm(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.uploads.confirm(req, body), req)
  }

  @Write({ action: APLUS_ACTIONS.created, resourceType: 'AplusContent', permission: APLUS_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  // PATCH 与项目里其它 PATCH 写入一致，用默认的 200（创建类 POST 是 201）
  @Write({ action: APLUS_ACTIONS.updated, resourceType: 'AplusContent', permission: APLUS_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  @Write({ action: APLUS_ACTIONS.asinsAssociated, resourceType: 'AplusContent', permission: APLUS_WRITE })
  @Post(':id/asins')
  async associate(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.associate(req, id, body), req)
  }

  @Write({ action: APLUS_ACTIONS.submitted, resourceType: 'AplusContent', permission: APLUS_WRITE })
  @Post(':id/submit')
  async submit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.submit(req, id, body), req)
  }
}
