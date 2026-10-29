import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('antd', () => ({ Modal: { confirm } }))
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

const { ApiError } = await import('../../api')
const { conflictVersions, handleConflict } = await import('./conflict')

const conflict = new ApiError(409, 'CONFLICT', '对象已被他人修改', { currentVersion: 5, expectedVersion: 3 })

describe('乐观锁冲突提示', () => {
  beforeEach(() => confirm.mockClear())

  it('识别版本冲突并取出版本号', () => {
    expect(conflictVersions(conflict)).toEqual({ currentVersion: 5, expectedVersion: 3 })
  })

  it('其他 409（如幂等处理中）、其他错误、普通异常都不是版本冲突', () => {
    expect(conflictVersions(new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', '处理中'))).toBeNull()
    expect(conflictVersions(new ApiError(403, 'TENANT_ACCESS_DENIED', '无权限'))).toBeNull()
    expect(conflictVersions(new Error('网络错误'))).toBeNull()
    expect(conflictVersions(undefined)).toBeNull()
  })

  it('版本冲突：弹出刷新或合并的提示，选择后分别触发刷新与继续编辑', () => {
    const onReload = vi.fn()
    const onKeepEditing = vi.fn()
    expect(handleConflict(conflict, { objectLabel: '采购单', onReload, onKeepEditing })).toBe(true)
    const dialog = confirm.mock.calls[0][0]
    expect(dialog.title).toBe('采购单已被他人修改')
    expect(dialog.content).toContain('第 3 版')
    expect(dialog.content).toContain('第 5 版')
    expect(dialog.okText).toBe('刷新最新内容')
    expect(dialog.cancelText).toBe('继续编辑')
    dialog.onOk()
    dialog.onCancel()
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onKeepEditing).toHaveBeenCalledTimes(1)
  })

  it('不是版本冲突：不弹窗，返回 false 交给调用方按普通错误处理', () => {
    expect(handleConflict(new Error('x'), { objectLabel: '采购单', onReload: vi.fn() })).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('服务端没带版本号时提示仍然可用', () => {
    handleConflict(new ApiError(409, 'CONFLICT', '冲突'), { objectLabel: '角色', onReload: vi.fn() })
    expect(confirm.mock.calls[0][0].content).not.toContain('第')
  })
})
