import { StorageError } from './errors.js'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const MAX_KEY_LENGTH = 700

/**
 * 存储层的路径校验：必须形如 tenants/<租户>/<数据域>/<年>/<月>/<日>/<文件名>。
 * 拒绝目录穿越、反斜杠、空段、隐藏文件、过长路径——适配器只接受这样的路径。
 */
export function assertStorageKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new StorageError('STORAGE_KEY_INVALID', '文件路径不合法')
  const segments = key.split('/')
  if (segments.length < 3 || segments[0] !== 'tenants') throw new StorageError('STORAGE_KEY_INVALID', '文件路径不合法')
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.includes('..')) throw new StorageError('STORAGE_KEY_INVALID', '文件路径不合法')
  }
  return key
}

/** 把原始文件名净化成可放进路径的一段：保留字母数字与 `._-`，其余变成下划线；不会以点开头，长度有限。 */
export function safeFileName(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .slice(0, 100)
  return cleaned.length > 0 ? cleaned : fallback
}
