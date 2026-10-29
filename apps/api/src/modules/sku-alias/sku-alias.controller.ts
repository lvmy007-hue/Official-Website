import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { SKU_ALIAS_ACTIONS, SKU_ALIAS_MANAGE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PackingMappingService } from './packing-mapping.service'
import { SkuAliasImportService } from './sku-alias-import.service'
import { SkuAliasService } from './sku-alias.service'

// 外部货号映射与装箱单列映射接口（P6-11）：读取要 inbound.read，写入要 skualias.manage（在服务里先于参数校验检查）。
// 静态路径（import、export）写在 `:id` 之前；查询参数类型必须直接写 Record<string, string>。
@UseGuards(AuthGuard)
@Controller()
export class SkuAliasController {
  constructor(
    private readonly aliases: SkuAliasService,
    private readonly imports: SkuAliasImportService,
    private readonly mappings: PackingMappingService,
  ) {}

  @Get('sku-aliases')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.aliases.list(req, query), req)
  }

  @Get('sku-aliases/export')
  async exportFile(@Req() req: RequestWithContext) {
    return ok(await this.imports.exportFile(req), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.imported, resourceType: 'SkuAlias', permission: SKU_ALIAS_MANAGE })
  @HttpCode(200)
  @Post('sku-aliases/import')
  async importFile(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.imports.importFile(req, body), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.created, resourceType: 'SkuAlias', permission: SKU_ALIAS_MANAGE })
  @Post('sku-aliases')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.aliases.create(req, body), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.updated, resourceType: 'SkuAlias', permission: SKU_ALIAS_MANAGE })
  @Put('sku-aliases/:id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.aliases.update(req, id, body), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.deleted, resourceType: 'SkuAlias', permission: SKU_ALIAS_MANAGE })
  @Delete('sku-aliases/:id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.aliases.remove(req, id), req)
  }

  @Get('packing-list-mappings')
  async mappingList(@Req() req: RequestWithContext) {
    return ok(await this.mappings.list(req), req)
  }

  @Get('packing-list-mappings/:supplierId')
  async mappingOne(@Req() req: RequestWithContext, @Param('supplierId') supplierId: string) {
    return ok(await this.mappings.one(req, supplierId), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.mappingSaved, resourceType: 'PackingListMapping', permission: SKU_ALIAS_MANAGE })
  @Put('packing-list-mappings/:supplierId')
  async mappingSave(@Req() req: RequestWithContext, @Param('supplierId') supplierId: string, @Body() body: unknown) {
    return ok(await this.mappings.save(req, supplierId, body), req)
  }

  @Write({ action: SKU_ALIAS_ACTIONS.mappingDeleted, resourceType: 'PackingListMapping', permission: SKU_ALIAS_MANAGE })
  @Delete('packing-list-mappings/:supplierId')
  async mappingRemove(@Req() req: RequestWithContext, @Param('supplierId') supplierId: string) {
    return ok(await this.mappings.remove(req, supplierId), req)
  }
}
