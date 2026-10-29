import { parseCloseState, CLOSE_STEP_KEYS, type CloseState, type CloseStepKey } from './close-state'
import { exportTenant } from './close-export'
import { deleteBuyerInformation, deleteBusinessData, deleteTokens, revokeAuthorizations, type CloseDeps } from './close-steps'

const brief = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

type StepOutput = { detail: Record<string, unknown>; patch?: Partial<CloseState> }

// 注销流程（P1-19，12.7 第 7 条）：导出 → 撤销授权 → 删令牌 → 删买家信息 → 删业务数据与文件 → 删除证明。
// 每步幂等，进度写入 Tenant.closeStateJson；失败时记录失败的步骤并抛出，由队列重试，重试从失败的那一步继续。
// 只有企业处于“注销中”才会执行；已注销的任务直接结束（重复投递安全）。
export async function runTenantClose(deps: CloseDeps, tenantId: string): Promise<{ status: 'CLOSED' | 'SKIPPED' }> {
  const now = deps.now ?? (() => new Date())
  const tenant = await deps.db.tenant.findUnique({ where: { id: tenantId }, select: { lifecycleStatus: true, closeStateJson: true } })
  if (!tenant || tenant.lifecycleStatus !== 'CLOSING') return { status: 'SKIPPED' }
  let state = parseCloseState(tenant.closeStateJson)
  const save = async (next: CloseState) => {
    state = next
    await deps.db.tenant.update({ where: { id: tenantId }, data: { closeStateJson: next as unknown as object } })
  }
  await save({ ...state, failed: false })

  const run: Record<CloseStepKey, () => Promise<StepOutput>> = {
    EXPORT: async () => {
      const result = await exportTenant(deps, tenantId)
      return {
        detail: { rows: result.rows, bytes: result.bytes, tables: result.tables },
        patch: { export: { key: result.key, bytes: result.bytes, sha256: result.sha256, rows: result.rows, expiresAt: result.expiresAt } },
      }
    },
    REVOKE_AUTH: async () => ({ detail: await revokeAuthorizations(deps, tenantId) }),
    DELETE_TOKENS: async () => ({ detail: await deleteTokens(deps, tenantId) }),
    DELETE_PII: async () => ({ detail: await deleteBuyerInformation(deps, tenantId) }),
    DELETE_DATA: async () => {
      const previous = state.steps.DELETE_DATA.detail as { tables?: Record<string, number>; userIds?: string[] } | undefined
      const result = await deleteBusinessData(deps, tenantId, previous)
      return { detail: { tables: result.tables, files: result.files, usersRemoved: result.usersRemoved, userIds: result.userIds } }
    },
    PROOF: async () => {
      const data = state.steps.DELETE_DATA.detail as { tables?: Record<string, number>; files?: number } | undefined
      const completedAt = now().toISOString()
      const proof = {
        completedAt,
        tables: data?.tables ?? {},
        files: Number(data?.files ?? 0),
        authorizationsRevokedLocally: Number((state.steps.REVOKE_AUTH.detail as { revokedLocally?: number } | undefined)?.revokedLocally ?? 0),
      }
      return { detail: { completedAt }, patch: { proof } }
    },
  }

  for (const key of CLOSE_STEP_KEYS) {
    if (state.steps[key].state === 'DONE') continue
    try {
      const output = await run[key]()
      await save({ ...state, ...output.patch, steps: { ...state.steps, [key]: { state: 'DONE', finishedAt: now().toISOString(), detail: output.detail } } })
      deps.logger.info({ tenantId, step: key }, '注销步骤完成')
    } catch (error) {
      await save({ ...state, failed: true, steps: { ...state.steps, [key]: { state: 'FAILED', error: brief(error) } } })
      deps.logger.warn({ tenantId, step: key, error: brief(error) }, '注销步骤失败')
      throw error
    }
  }

  const completedAt = state.proof?.completedAt ?? now().toISOString()
  const exportSummary = state.export ? { bytes: state.export.bytes, sha256: state.export.sha256, expiresAt: state.export.expiresAt } : null
  await deps.db.$transaction([
    deps.db.tenant.update({
      where: { id: tenantId },
      data: { lifecycleStatus: 'CLOSED', lifecycleChangedAt: new Date(completedAt), closedAt: new Date(completedAt), closeStateJson: state as unknown as object },
    }),
    deps.db.tenantLifecycleEvent.create({
      data: { tenantId, fromStatus: 'CLOSING', toStatus: 'CLOSED', reason: '注销完成，已生成删除证明', detailJson: { proof: state.proof, export: exportSummary } as object },
    }),
  ])
  return { status: 'CLOSED' }
}
