import { Modal } from 'antd'
import { ApiError } from '../../api'

// 乐观锁冲突（409 CONFLICT）的统一处理：所有“带版本号保存”的页面共用，提示用户刷新或合并，不假装保存成功。

export interface ConflictVersions {
  currentVersion: number | null
  expectedVersion: number | null
}

const asNumber = (value: unknown) => (typeof value === 'number' ? value : null)

/** 判断是否为版本冲突；是则取出服务端给出的当前版本与自己编辑时的版本。 */
export function conflictVersions(error: unknown): ConflictVersions | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'CONFLICT') return null
  return { currentVersion: asNumber(error.details?.currentVersion), expectedVersion: asNumber(error.details?.expectedVersion) }
}

export interface ConflictPromptOptions {
  /** 对象的中文名称，如“采购单”。 */
  objectLabel: string
  /** 用户选择刷新：页面重新读取最新内容。 */
  onReload: () => void | Promise<void>
  /** 用户选择继续编辑：保留当前表单，便于对照后手动合并。 */
  onKeepEditing?: () => void
}

/** 如果是版本冲突，弹出“刷新或合并”的提示并返回 true；否则返回 false，由调用方按普通错误处理。 */
export function handleConflict(error: unknown, options: ConflictPromptOptions): boolean {
  const versions = conflictVersions(error)
  if (!versions) return false
  const detail = versions.currentVersion !== null && versions.expectedVersion !== null ? `（你编辑的是第 ${versions.expectedVersion} 版，现在已是第 ${versions.currentVersion} 版）` : ''
  Modal.confirm({
    title: `${options.objectLabel}已被他人修改`,
    content: `你的修改没有保存${detail}。可以先刷新查看最新内容；也可以继续编辑，对照最新内容后手动合并再保存。`,
    okText: '刷新最新内容',
    cancelText: '继续编辑',
    onOk: () => options.onReload(),
    onCancel: () => options.onKeepEditing?.(),
  })
  return true
}
