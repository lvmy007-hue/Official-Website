import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { LABEL_TEMPLATE_ACTIONS, LABEL_TEMPLATE_MANAGE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { LabelTemplatesService } from './label-templates.service'

// 标签模板接口（P6-12）：读取要 inbound.read，写入要 labeltemplate.manage（在服务里先于参数校验检查）。查询参数类型必须直接写 Record<string, string>。
@UseGuards(AuthGuard)
@Controller('label-templates')
export class LabelTemplatesController {
  constructor(private readonly templates: LabelTemplatesService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.templates.list(req, query), req)
  }

  @Write({ action: LABEL_TEMPLATE_ACTIONS.created, resourceType: 'LabelTemplate', permission: LABEL_TEMPLATE_MANAGE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.templates.create(req, body), req)
  }

  @Write({ action: LABEL_TEMPLATE_ACTIONS.updated, resourceType: 'LabelTemplate', permission: LABEL_TEMPLATE_MANAGE })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.templates.update(req, id, body), req)
  }

  @Write({ action: LABEL_TEMPLATE_ACTIONS.deleted, resourceType: 'LabelTemplate', permission: LABEL_TEMPLATE_MANAGE })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.templates.remove(req, id), req)
  }
}
