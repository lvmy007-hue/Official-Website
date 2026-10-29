import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isKnownPermission } from '@nova/authz'

// 接口里出现的每个权限点，都必须在冻结清单（freeze/permissions.md，生成到 @nova/authz 目录）里有定义。
// 新接口写了清单里没有的权限点，持续集成直接失败。
const MODULES = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}

describe('接口权限点登记', () => {
  const used: { file: string; key: string }[] = []
  for (const file of sourceFiles(MODULES)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\.(?:authorize|authorizeScoped)\(\s*req\s*,\s*'([^']+)'/g)) used.push({ file, key: match[1] })
  }

  it('确实扫描到了接口里的权限检查', () => {
    expect(used.length).toBeGreaterThan(30)
  })

  it('每个权限点都已登记（含保留识别期内的旧点位）', () => {
    const unknown = used.filter(item => !isKnownPermission(item.key)).map(item => `${item.file.replace(MODULES, '')}: ${item.key}`)
    expect(unknown).toEqual([])
  })

  it('接口不再使用已拆分的旧点位：seller.read、seller.write、refunds.read', () => {
    const legacy = used.filter(item => ['seller.read', 'seller.write', 'refunds.read'].includes(item.key)).map(item => `${item.file.replace(MODULES, '')}: ${item.key}`)
    expect(legacy).toEqual([])
  })
})
