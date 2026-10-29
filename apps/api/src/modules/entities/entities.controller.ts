import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ENTITY_WRITE, LEGAL_ENTITY_ACTIONS } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { EntitiesDetailService } from './entities-detail.service'
import { EntitiesService } from './entities.service'

// 法律主体（P5-07，09 章 9.9；freeze/api.md /entities*）。
@UseGuards(AuthGuard)
@Controller('entities')
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    private readonly details: EntitiesDetailService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.entities.list(req, query), req)
  }

  @Write({ action: LEGAL_ENTITY_ACTIONS.created, resourceType: 'LegalEntity', permission: ENTITY_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    const result = await this.entities.create(req, body)
    return response.status(201).json(ok(result, req))
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: LEGAL_ENTITY_ACTIONS.updated, resourceType: 'LegalEntity', permission: ENTITY_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.entities.update(req, id, body), req)
  }
}
