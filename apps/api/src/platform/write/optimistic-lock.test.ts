import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../http'
import { expectedVersionFrom, updateWithVersion, type VersionedDelegate } from './optimistic-lock'

type Row = { id: string; version: number; notes?: string }

function delegate(options: { count: number; current?: Row | null; fresh?: Row | null }) {
  // 更新成功只查一次（取最新记录）；更新没有生效则只查一次（取当前版本，判断是冲突还是不存在）
  const findFirst = vi.fn().mockResolvedValue(options.count > 0 ? (options.fresh ?? null) : (options.current ?? null))
  const updateMany = vi.fn().mockResolvedValue({ count: options.count })
  const model: VersionedDelegate<Row> = { findFirst, updateMany }
  return { ...model, findFirst, updateMany }
}

const fail = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as AppError
  }
  throw new Error('预期抛出错误，但没有')
}

describe('乐观锁：expectedVersionFrom', () => {
  it('取出请求体里的版本号', () => {
    expect(expectedVersionFrom({ version: 3, notes: 'x' })).toBe(3)
  })

  it.each([[undefined], [null], [{}], [{ version: 0 }], [{ version: 1.5 }], [{ version: '2' }]])('缺失或不合法的版本号（%j）返回 422 并指向 version 字段', async body => {
    const error = await fail(Promise.resolve().then(() => expectedVersionFrom(body)))
    expect(error.getStatus()).toBe(422)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.fieldErrors?.version).toBeTruthy()
  })
})

describe('乐观锁：updateWithVersion', () => {
  it('更新条件带上版本号，并让版本加一；返回最新记录', async () => {
    const d = delegate({ count: 1, fresh: { id: 'a', version: 4, notes: 'new' } })
    const row = await updateWithVersion(d, { id: 'a', tenantId: 't1' }, 3, { notes: 'new' }, { label: '采购单' })
    expect(d.updateMany).toHaveBeenCalledWith({ where: { id: 'a', tenantId: 't1', version: 3 }, data: { notes: 'new', version: { increment: 1 } } })
    expect(row).toEqual({ id: 'a', version: 4, notes: 'new' })
  })

  it('版本不一致：409 CONFLICT，并告知当前版本号', async () => {
    const d = delegate({ count: 0, current: { id: 'a', version: 5 } })
    const error = await fail(updateWithVersion(d, { id: 'a' }, 3, { notes: 'x' }, { label: '采购单' }))
    expect(error.getStatus()).toBe(409)
    expect(error.code).toBe('CONFLICT')
    expect(error.message).toContain('采购单已被他人修改')
    expect(error.details).toEqual({ currentVersion: 5, expectedVersion: 3 })
  })

  it('对象不存在（或不属于当前企业）：404，而不是冲突', async () => {
    const d = delegate({ count: 0, current: null })
    const error = await fail(updateWithVersion(d, { id: 'missing', tenantId: 't1' }, 1, { notes: 'x' }, { label: '采购单' }))
    expect(error.getStatus()).toBe(404)
    expect(error.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('调用方不得自行写 version', async () => {
    const d = delegate({ count: 1 })
    await expect(updateWithVersion(d, { id: 'a' }, 1, { version: 99 })).rejects.toThrow('不允许')
    expect(d.updateMany).not.toHaveBeenCalled()
  })

  it('更新成功后对象被同时删除：返回 404', async () => {
    const d = delegate({ count: 1, fresh: null })
    const error = await fail(updateWithVersion(d, { id: 'a' }, 1, { notes: 'x' }))
    expect(error.code).toBe('RESOURCE_NOT_FOUND')
  })
})
