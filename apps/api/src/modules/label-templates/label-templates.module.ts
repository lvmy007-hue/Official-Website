import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { LabelTemplatesController } from './label-templates.controller'
import { LabelTemplatesService } from './label-templates.service'

@Module({
  imports: [AuthModule],
  controllers: [LabelTemplatesController],
  providers: [LabelTemplatesService],
  exports: [LabelTemplatesService],
})
export class LabelTemplatesModule {}
