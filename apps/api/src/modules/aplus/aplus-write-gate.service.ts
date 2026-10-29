import { Injectable } from '@nestjs/common'
import { APLUS_SWITCH_KEY, APLUS_WRITE, aplusActionsOf, aplusModulesFromAmazon, type AplusActions, type AplusModulesView, type AplusStatus } from '@nova/api-contracts'
import type { AplusContent, PlatformConnection } from '@prisma/client'
import { appError, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { assertStoreInScope, storeWhere, type ResolvedScope } from '../auth'
import { modulesOf, runStateOf } from './aplus-common'
import { AplusJobService } from './aplus-jobs.service'

/**
 * A+ 写入的共同前置检查（P4-14）。固定顺序：权限与参数校验由调用方先做 → 店铺（或内容所在店铺）在成员范围内 → 动作守卫（店铺连接、写入开关）→ 业务条件。
 * 业务条件针对已有内容：版本一致（乐观锁的提前检查，真正的保证在事务里的条件更新）→ 没有进行中的写入 → 动作可用（同页面按钮同一套判断）。
 */
@Injectable()
export class AplusWriteGate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: ActionGuardService,
    private readonly jobs: AplusJobService,
  ) {}

  private async channel(context: ApiContext, storeId: string): Promise<PlatformConnection> {
    await this.guard.assert(context, { permission: APLUS_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: storeId }, switchKey: APLUS_SWITCH_KEY })
    return this.jobs.connectionOf(context.tenantId, storeId)
  }

  /** 创建与上传图片：店铺在范围内（403）→ 店铺存在（404）→ 连接与开关（409）。 */
  async forStore(context: ApiContext, scope: ResolvedScope, storeId: string): Promise<PlatformConnection> {
    assertStoreInScope(scope, storeId)
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: storeId, tenantId: context.tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    return this.channel(context, storeId)
  }

  /** 已有内容的写入：内容存在且在范围内（范围外与别的企业一律 404）→ 连接与开关（409）。 */
  async forContent(context: ApiContext, scope: ResolvedScope, id: string): Promise<{ content: AplusContent; connection: PlatformConnection }> {
    const content = await this.prisma.aplusContent.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!content) throw appError('RESOURCE_NOT_FOUND', '内容不存在')
    return { content, connection: await this.channel(context, content.sellerAccountId) }
  }

  /** 版本一致、没有进行中的写入、动作可用（409）；返回当前文档的表单转换结果，供调用方判断能否编辑。 */
  async assertActionable(context: ApiContext, content: AplusContent, version: number, action: keyof AplusActions): Promise<{ view: AplusModulesView }> {
    if (content.version !== version) {
      throw appError('CONFLICT', '这份内容已被他人修改，请刷新后查看最新内容，再决定是否合并你的修改', { details: { currentVersion: content.version, expectedVersion: version } })
    }
    const state = await runStateOf(this.prisma, context.tenantId, content.id)
    if (state.pending) throw appError('CONFLICT', '这份内容有一个写入正在处理，请等它完成后再操作', { details: { code: 'APLUS_RUN_BUSY' } })
    const view = aplusModulesFromAmazon(modulesOf(content.draftJson))
    const hasKey = content.contentReferenceKey !== null
    const actions = aplusActionsOf({
      status: content.status as AplusStatus,
      hasKey,
      busy: false,
      asinCount: content.asinCount,
      editable: view.editable,
      editNote: view.note,
      createFailed: !hasKey && state.createFailed,
    })
    const decision = actions[action]
    if (!decision.allowed) throw appError('DATA_CONDITION_FAILED', decision.reason ?? '当前状态不允许这个操作', { details: { code: 'APLUS_ACTION_NOT_ALLOWED', action } })
    return { view }
  }
}
