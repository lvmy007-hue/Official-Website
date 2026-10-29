import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AlipayService } from './alipay.service'
import { CommerceController } from './commerce.controller'
import { CommerceService } from './commerce.service'

@Module({ imports: [AuthModule], controllers: [CommerceController], providers: [AlipayService, CommerceService] })
export class CommerceModule {}
