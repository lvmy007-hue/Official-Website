import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ROLE_ACTIONS, ROLE_MANAGE, ROLE_STEP_UP } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { RolesService } from './roles.service'

// 角色与权限矩阵（P5-08，09 章 9.10；freeze/api.md /roles*）。新建与修改需要再次验证身份。
@UseGuards(AuthGuard)
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  async list(@Req() req: RequestWithContext) {
    return ok(await this.roles.list(req), req)
  }

  @Write({ action: ROLE_ACTIONS.created, resourceType: 'Role', permission: ROLE_MANAGE, stepUp: ROLE_STEP_UP })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.roles.create(req, body), req))
  }

  @Write({ action: ROLE_ACTIONS.updated, resourceType: 'Role', permission: ROLE_MANAGE, stepUp: ROLE_STEP_UP })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.roles.update(req, id, body), req)
  }
}
