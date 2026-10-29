import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ProfitItemsSaveService } from './profit-items-save.service'
import { ProfitItemsController } from './profit-items.controller'
import { ProfitItemsService } from './profit-items.service'

@Module({
  imports: [AuthModule],
  controllers: [ProfitItemsController],
  providers: [ProfitItemsService, ProfitItemsSaveService],
})
export class ProfitItemsModule {}
