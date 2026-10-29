import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  APLUS_ACTIONS,
  APLUS_MARKETPLACE_ID,
  APLUS_WRITE,
  AplusAsinBodySchema,
  AplusCreateBodySchema,
  AplusSubmitBodySchema,
  AplusUpdateBodySchema,
  aplusFormModulesOf,
  aplusImageRefs,
  aplusModuleIssues,
  aplusModulesToAmazon,
  type AplusFormModule,
  type AplusWriteResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { AplusAcceptService, json, type Accepted } from './aplus-accept.service'
import { isRecord, modulesOf } from './aplus-common'
import { assertImagesUsable } from './aplus-images-check'
import { AplusWriteGate } from './aplus-write-gate.service'

const resultOf = (accepted: Accepted): AplusWriteResult => ({ contentId: accepted.contentId, runId: accepted.runId, status: 'QUEUED', version: accepted.version, queued: accepted.queued })

/** 内容校验不过：422，说明取第一条问题（整份校验结果由页面在提交前就能算出，这里只是兜底）。 */
function assertModulesValid(modules: readonly AplusFormModule[]): void {
  const issue = aplusModuleIssues(modules)[0]
  if (issue) throw appError('VALIDATION_FAILED', issue.message, { fieldErrors: { modules: [issue.message] } })
}

/**
 * A+ 内容的写入入口（P4-14；05 章 5.8）：创建、保存修改、关联 ASIN、提交审核。
 * 顺序：权限（先于参数）→ 参数（422）→ 店铺在范围内（403，内容路由按内容找，范围外 404）→ 连接与开关（409）→ 业务条件（版本、进行中的写入、动作可用，409；内容与图片，422）
 *   → 事务内建内容或更新版本、写入记录、任务并写审计 → 提交后入队。亚马逊的调用都在后台任务里，结果在“写入记录”里看。
 * 受理时草稿（名称与文档）立刻更新，版本加一；亚马逊那边创建或更新失败时草稿保留，用户可以改了再保存。
 */
@Injectable()
export class AplusWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly gate: AplusWriteGate,
    private readonly accepts: AplusAcceptService,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<AplusWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusCreateBodySchema.parse(rawBody)
    const connection = await this.gate.forStore(context, scope, body.storeId)
    const modules = body.modules as AplusFormModule[]
    assertModulesValid(modules)
    await assertImagesUsable(this.prisma, { tenantId: context.tenantId, storeId: body.storeId, refs: aplusImageRefs(modules) })
    const contentModuleList = aplusModulesToAmazon(modules)
    const contentId = randomUUID()
    const accepted = await this.accepts.accept(req, context, {
      storeId: body.storeId,
      connectionId: connection.id,
      kind: 'CREATE',
      contentId,
      requestJson: { name: body.name, contentType: body.contentType, locale: body.locale, contentModuleList },
      create: {
        sellerAccountId: body.storeId,
        marketplaceId: APLUS_MARKETPLACE_ID,
        contentReferenceKey: null,
        name: body.name,
        contentType: body.contentType,
        locale: body.locale,
        status: 'DRAFT',
        draftJson: json({ contentModuleList }),
        version: 1,
        createdBy: context.userId,
      },
      audit: {
        action: APLUS_ACTIONS.created,
        resourceType: 'AplusContent',
        resourceId: contentId,
        after: { storeId: body.storeId, name: body.name, contentType: body.contentType, modules: modules.length },
      },
    })
    return resultOf(accepted)
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<AplusWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusUpdateBodySchema.parse(rawBody)
    const { content, connection } = await this.gate.forContent(context, scope, id)
    const { view } = await this.gate.assertActionable(context, content, body.version, 'edit')
    // 更新是整份快照：当前文档里有编辑器不支持的模块时，不管改名称还是改模块都会覆盖亚马逊上我们不认识的内容，一律拒绝
    if (!view.editable) throw appError('DATA_CONDITION_FAILED', view.note ?? '这份内容包含编辑器不支持的模块，只能预览', { details: { code: 'APLUS_NOT_EDITABLE' } })
    const current = modulesOf(content.draftJson)
    const modules = body.modules as AplusFormModule[] | undefined
    if (modules) {
      assertModulesValid(modules)
      // 当前文档里已有的图片沿用旧图，不需要重新上传；只有新选的图片才核对上传记录与尺寸
      const keep = new Set(aplusImageRefs(view.modules.filter((item): item is AplusFormModule => item !== null)).map(ref => ref.uploadDestinationId))
      await assertImagesUsable(this.prisma, { tenantId: context.tenantId, storeId: content.sellerAccountId, refs: aplusImageRefs(modules), keep })
    } else if (current.length === 0) {
      const text = '这份内容还没有同步到模块内容，只改名称会清空亚马逊上的内容，请同时提交模块'
      throw appError('VALIDATION_FAILED', text, { fieldErrors: { modules: [text] } })
    }
    const contentModuleList = modules ? aplusModulesToAmazon(modules) : current
    const name = body.name ?? content.name
    // 没有亚马逊编号（创建失败过）的内容保存时重新发起创建，而不是更新
    const kind = content.contentReferenceKey === null ? 'CREATE' : 'UPDATE'
    const accepted = await this.accepts.accept(req, context, {
      storeId: content.sellerAccountId,
      connectionId: connection.id,
      kind,
      contentId: content.id,
      requestJson: { name, contentType: content.contentType, locale: content.locale, contentModuleList },
      update: { version: body.version, data: { name, draftJson: json({ ...(isRecord(content.draftJson) ? content.draftJson : {}), contentModuleList }) } },
      audit: { action: APLUS_ACTIONS.updated, resourceType: 'AplusContent', resourceId: content.id, after: { storeId: content.sellerAccountId, name, kind, modules: contentModuleList.length } },
    })
    return resultOf(accepted)
  }

  async associate(req: RequestWithContext, id: string, rawBody: unknown): Promise<AplusWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusAsinBodySchema.parse(rawBody)
    const { content, connection } = await this.gate.forContent(context, scope, id)
    await this.gate.assertActionable(context, content, body.version, 'associate')
    const accepted = await this.accepts.accept(req, context, {
      storeId: content.sellerAccountId,
      connectionId: connection.id,
      kind: 'ASSOCIATE',
      contentId: content.id,
      requestJson: { asins: body.asins },
      update: { version: body.version, data: {} },
      audit: { action: APLUS_ACTIONS.asinsAssociated, resourceType: 'AplusContent', resourceId: content.id, after: { storeId: content.sellerAccountId, asins: body.asins } },
    })
    return resultOf(accepted)
  }

  async submit(req: RequestWithContext, id: string, rawBody: unknown): Promise<AplusWriteResult> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_WRITE, {})
    const body = AplusSubmitBodySchema.parse(rawBody)
    const { content, connection } = await this.gate.forContent(context, scope, id)
    await this.gate.assertActionable(context, content, body.version, 'submit')
    // 当前草稿能转成编辑器模型时按模型校验（必填、长度、图片）；含编辑器不认识的模块时无法校验，交给亚马逊审核
    const forms = aplusFormModulesOf(modulesOf(content.draftJson))
    if (forms) assertModulesValid(forms)
    const accepted = await this.accepts.accept(req, context, {
      storeId: content.sellerAccountId,
      connectionId: connection.id,
      kind: 'SUBMIT',
      contentId: content.id,
      requestJson: {},
      update: { version: body.version, data: {} },
      audit: { action: APLUS_ACTIONS.submitted, resourceType: 'AplusContent', resourceId: content.id, after: { storeId: content.sellerAccountId, name: content.name } },
    })
    return resultOf(accepted)
  }
}
