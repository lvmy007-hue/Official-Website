import { Injectable } from '@nestjs/common'
import { PreferencesUpdateBodySchema, densityOf, favoritesOf, notifyPrefsOf, type PreferencesResponse } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'

const PERSONAL = 'profile.manage'
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Stored = { notifyJson?: unknown; favoriteRoutes?: unknown; density?: unknown } | null | undefined
const snapshotOf = (row: Stored) => ({ notify: notifyPrefsOf(row?.notifyJson), favorites: favoritesOf(row?.favoriteRoutes), density: densityOf(row?.density) })

// 个人偏好（P5-11 起，P6-01 合并收藏与密度；freeze/api.md GET、PUT /me/preferences）：
// 通知偏好与免打扰时段、侧边导航收藏、界面密度，每个成员在每个企业里一份。
// 没有保存过时返回默认值（全部接收、免打扰关闭、无收藏、标准密度，版本 0）；
// 保存时 notify、favorites、density 三项各自可省略（省略的项保持不变），出现的项整体替换，带版本号，别处已改过返回 409。
// 内部访问与平台支持访问没有个人账号，不支持。
@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async personal(req: RequestWithContext) {
    const context = await this.context.authorize(req, PERSONAL)
    if (context.accessMode === 'INTERNAL_DIRECT' || context.accessMode === 'SUPPORT') throw appError('INTERNAL_ACCESS_UNSUPPORTED', '内部访问与支持访问模式没有个人账号，不支持该操作')
    return context
  }

  private async zoneOf(tenantId: string): Promise<string> {
    return (await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { localTimezone: true } })).localTimezone
  }

  async get(req: RequestWithContext): Promise<PreferencesResponse> {
    const context = await this.personal(req)
    const row = await this.prisma.userPreference.findFirst({ where: { tenantId: context.tenantId, userId: context.userId } })
    return { ...snapshotOf(row), version: row?.version ?? 0, updatedAt: row ? row.updatedAt.toISOString() : null, zone: await this.zoneOf(context.tenantId) }
  }

  async update(req: RequestWithContext, rawBody: unknown): Promise<PreferencesResponse> {
    const context = await this.personal(req)
    const body = PreferencesUpdateBodySchema.parse(rawBody)
    const zone = await this.zoneOf(context.tenantId)
    const saved = await this.prisma.$transaction(async tx => {
      const current = await tx.userPreference.findFirst({ where: { tenantId: context.tenantId, userId: context.userId } })
      const before = snapshotOf(current)
      const after = { notify: body.notify ?? before.notify, favorites: body.favorites ?? before.favorites, density: body.density ?? before.density }
      if (sameJson(before, after)) throw appError('VALIDATION_FAILED', '和当前设置完全相同，没有需要保存的修改')
      // 只写请求里出现的项，其余保持不变
      const data: Prisma.UserPreferenceUncheckedUpdateManyInput = {
        ...(body.notify ? { notifyJson: body.notify as unknown as Prisma.InputJsonValue } : {}),
        ...(body.favorites ? { favoriteRoutes: body.favorites } : {}),
        ...(body.density ? { density: body.density } : {}),
      }
      let version: number
      let updatedAt: Date
      if (!current) {
        if (body.version !== 0) throw appError('CONFLICT', '偏好已被修改，请刷新后重试', { details: { expectedVersion: body.version } })
        try {
          const created = await tx.userPreference.create({ data: { tenantId: context.tenantId, userId: context.userId, ...data } as Prisma.UserPreferenceUncheckedCreateInput })
          ;({ version, updatedAt } = created)
        } catch (error) {
          if ((error as { code?: string }).code === 'P2002') throw appError('CONFLICT', '偏好已被修改，请刷新后重试', { details: { expectedVersion: body.version } })
          throw error
        }
      } else {
        const result = await tx.userPreference.updateMany({ where: { id: current.id, version: body.version }, data: { ...data, version: { increment: 1 } } })
        if (result.count === 0)
          throw appError('CONFLICT', '偏好已在别处被修改（可能是你在另一台设备上保存了），请刷新后查看最新内容', { details: { currentVersion: current.version, expectedVersion: body.version } })
        const fresh = await tx.userPreference.findUniqueOrThrow({ where: { id: current.id } })
        ;({ version, updatedAt } = fresh)
      }
      // 审计只记录这次请求里出现的项（收藏每点一次星就是一次保存，别把没动的通知偏好整份写进去）
      const keys = (['notify', 'favorites', 'density'] as const).filter(key => body[key] !== undefined)
      const pick = (source: typeof before) => Object.fromEntries(keys.map(key => [key, source[key]]))
      await this.audit.record(req, { action: 'USER_PREFERENCES_UPDATED', resourceType: 'UserPreference', resourceId: context.userId, before: pick(before), after: pick(after) }, { client: tx })
      return { version, updatedAt, after }
    })
    return { ...saved.after, version: saved.version, updatedAt: saved.updatedAt.toISOString(), zone }
  }
}
