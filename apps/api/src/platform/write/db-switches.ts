import { Injectable } from '@nestjs/common'
import { emergencyDisableReason, switchSpecOf } from '@nova/api-contracts'
import { PrismaService } from '../prisma.service'
import { IntegrationSwitchPort } from './action-guard.service'

// 写入开关的数据库实现（P1-28）：读取 IntegrationSwitch 表；部署环境变量的紧急强制关闭优先级最高；没有记录一律视为关闭（默认只读）。
// 本期开关是企业级：sellerAccountId 参数保留为接口形状，不参与判断。
@Injectable()
export class DbSwitches extends IntegrationSwitchPort {
  constructor(private readonly prisma: PrismaService) {
    super()
  }

  async status(tenantId: string, switchKey: string) {
    if (!switchSpecOf(switchKey)) return { enabled: false, reason: '未知的写入开关，已按关闭处理' }
    const forced = emergencyDisableReason(switchKey, process.env)
    if (forced) return { enabled: false, reason: forced }
    const row = await this.prisma.integrationSwitch.findFirst({ where: { tenantId, switchKey, sellerAccountId: null }, select: { enabled: true, autoDisabledReason: true } })
    if (row?.enabled) return { enabled: true }
    if (row?.autoDisabledReason) return { enabled: false, reason: `该类写入已被系统自动关闭（${row.autoDisabledReason}），请到“接口与写入开关”检查后重新开启` }
    return { enabled: false, reason: '该类写入的开关未开启（默认只读），请管理员在“接口与写入开关”开启' }
  }
}
