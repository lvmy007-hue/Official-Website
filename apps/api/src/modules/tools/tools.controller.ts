import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { HIJACK_ACTIONS, HIJACK_MANAGE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { HijackListService } from './hijack-list.service'
import { HijackWhitelistService } from './hijack-whitelist.service'

// 工具（P6-17；16 章第 3.2 节；freeze/api.md /tools/hijack*）：跟卖监控与白名单。静态路径 whitelist 在 :id 之前。
// 数据只来自官方竞争摘要，不抓前台页面；写入只有白名单的新增与删除，只改本系统，不调用亚马逊。
@UseGuards(AuthGuard)
@Controller('tools/hijack')
export class ToolsController {
  constructor(
    private readonly lists: HijackListService,
    private readonly whitelist: HijackWhitelistService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Get('whitelist')
  async listWhitelist(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.whitelist.list(req, query), req)
  }

  @Write({ action: HIJACK_ACTIONS.whitelistAdded, resourceType: 'HijackWhitelist', permission: HIJACK_MANAGE })
  @Post('whitelist')
  async add(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.whitelist.add(req, body), req)
  }

  @Write({ action: HIJACK_ACTIONS.whitelistRemoved, resourceType: 'HijackWhitelist', permission: HIJACK_MANAGE })
  @Delete('whitelist/:id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.whitelist.remove(req, id), req)
  }
}
