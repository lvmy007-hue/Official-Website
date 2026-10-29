import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ERROR_CODES, isErrorCode } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { AppError, appError } from './http'

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !path.includes(`${join(SRC, 'testing')}`) ? [path] : []
  })
}

// 接口只能返回统一错误码目录里登记过的错误码，HTTP 状态与目录一致。
describe('统一错误码', () => {
  const used: { file: string; status: number; code: string }[] = []
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/new AppError\(\s*(\d{3})\s*,\s*'([A-Z0-9_]+)'/g)) used.push({ file: relative(SRC, file), status: Number(match[1]), code: match[2] })
    for (const match of text.matchAll(/appError\(\s*'([A-Z0-9_]+)'/g)) used.push({ file: relative(SRC, file), status: ERROR_CODES[match[1] as keyof typeof ERROR_CODES]?.status ?? 0, code: match[1] })
  }

  it('确实扫描到了错误码使用点', () => {
    expect(used.length).toBeGreaterThan(60)
  })

  it('代码里用到的每个错误码都已登记', () => {
    const unknown = used.filter(item => !isErrorCode(item.code)).map(item => `${item.file}: ${item.code}`)
    expect(unknown).toEqual([])
  })

  it('代码里写的 HTTP 状态与目录登记的一致（同一个错误码只有一个含义）', () => {
    const mismatched = used
      .filter(item => isErrorCode(item.code) && ERROR_CODES[item.code].status !== item.status)
      .map(item => `${item.file}: ${item.code} 写的是 ${item.status}，目录是 ${ERROR_CODES[item.code as keyof typeof ERROR_CODES].status}`)
    expect(mismatched).toEqual([])
  })

  it('目录自身合规：状态码在 400–599，错误码为全大写下划线，含义不为空', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(code, code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/)
      expect(spec.status, code).toBeGreaterThanOrEqual(400)
      expect(spec.status, code).toBeLessThan(600)
      expect(spec.meaning.length, code).toBeGreaterThan(3)
    }
  })

  it('按目录创建错误：状态与可重试取默认值，可覆盖，可带补充信息', () => {
    const error = appError('IDEMPOTENCY_IN_PROGRESS', '处理中')
    expect(error).toBeInstanceOf(AppError)
    expect(error.getStatus()).toBe(409)
    expect(error.retryable).toBe(true)
    const custom = appError('STEP_UP_REQUIRED', '需要验证', { retryable: false, details: { action: 'role.manage' } })
    expect(custom.details).toEqual({ action: 'role.manage' })
    expect(appError('CONFLICT', '冲突', { status: 412 }).getStatus()).toBe(412)
  })
})
