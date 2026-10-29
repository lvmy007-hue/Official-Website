import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { PackingMappingService } from './packing-mapping.service'
import { SkuAliasImportService } from './sku-alias-import.service'
import { SkuAliasController } from './sku-alias.controller'
import { SkuAliasService } from './sku-alias.service'

// 外部货号映射与供应商装箱单列映射（P6-11）：装箱单匹配（入仓模块）通过 SkuAliasService、PackingMappingService 读取与记忆映射。
@Module({
  imports: [AuthModule],
  controllers: [SkuAliasController],
  providers: [SkuAliasService, SkuAliasImportService, PackingMappingService],
  exports: [SkuAliasService, PackingMappingService],
})
export class SkuAliasModule {}
