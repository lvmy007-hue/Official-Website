import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { MemberSystemService } from './member-system.service'
import { MembersDetailService } from './members-detail.service'
import { MembersInviteService } from './members-invite.service'
import { MembersListService } from './members-list.service'
import { MembersWriteService } from './members-write.service'
import { MembersController } from './members.controller'
import { RolesController } from './roles.controller'
import { RolesService } from './roles.service'

@Module({
  imports: [AuthModule],
  controllers: [MembersController, RolesController],
  providers: [MemberSystemService, MembersListService, MembersDetailService, MembersInviteService, MembersWriteService, RolesService],
})
export class MembersModule {}
