import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { MEMBER_ACTIONS, MEMBER_INVITE, MEMBER_MANAGE, MEMBER_STEP_UP } from '@nova/api-contracts'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { MembersDetailService } from './members-detail.service'
import { MembersInviteService } from './members-invite.service'
import { MembersListService } from './members-list.service'
import { MembersWriteService } from './members-write.service'

// 成员（P5-08，09 章 9.10；freeze/api.md /members*）。停用、改角色、改范围需要再次验证身份。
@UseGuards(AuthGuard)
@Controller('members')
export class MembersController {
  constructor(
    private readonly list: MembersListService,
    private readonly details: MembersDetailService,
    private readonly invites: MembersInviteService,
    private readonly writes: MembersWriteService,
  ) {}

  @Get()
  async members(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  // 选人用的轻量列表；必须写在 :id 之前，否则会被当成成员编号
  @Get('options')
  async options(@Req() req: RequestWithContext) {
    return ok(await this.list.options(req), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: MEMBER_ACTIONS.invited, resourceType: 'MemberInvitation', permission: MEMBER_INVITE })
  @Post('invite')
  async invite(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.invites.invite(req, body), req))
  }

  @Write({ action: MEMBER_ACTIONS.disabled, resourceType: 'Membership', permission: MEMBER_MANAGE, stepUp: MEMBER_STEP_UP })
  @Post(':id/disable')
  async disable(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown, @Res() response: Response) {
    return response.status(200).json(ok(await this.writes.disable(req, id, body), req))
  }

  @Write({ action: MEMBER_ACTIONS.enabled, resourceType: 'Membership', permission: MEMBER_MANAGE, stepUp: MEMBER_STEP_UP })
  @Post(':id/enable')
  async enable(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown, @Res() response: Response) {
    return response.status(200).json(ok(await this.writes.enable(req, id, body), req))
  }

  @Write({ action: MEMBER_ACTIONS.roleChanged, resourceType: 'Membership', permission: MEMBER_MANAGE, stepUp: MEMBER_STEP_UP })
  @Post(':id/role')
  async role(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown, @Res() response: Response) {
    return response.status(200).json(ok(await this.writes.changeRole(req, id, body), req))
  }

  @Write({ action: MEMBER_ACTIONS.scopesChanged, resourceType: 'Membership', permission: MEMBER_MANAGE, stepUp: MEMBER_STEP_UP })
  @Post(':id/scopes')
  async scopes(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown, @Res() response: Response) {
    return response.status(200).json(ok(await this.writes.changeScopes(req, id, body), req))
  }
}
