import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 后台任务进程结构（P1-21，03 章 3.1）：入口只做装配；业务代码按职责分目录；单文件不超过 400 行。
const root = __dirname

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}
const lineCount = (path: string) => readFileSync(path, 'utf8').split('\n').length

describe('后台任务进程结构', () => {
  it('四个职责目录都存在', () => {
    for (const dir of ['connectors', 'importers', 'derivers', 'listeners']) expect(existsSync(join(root, dir)), dir).toBe(true)
  })

  it('每个源文件不超过 400 行', () => {
    const tooLong = sourceFiles(root)
      .map(path => ({ path: path.replace(root, ''), lines: lineCount(path) }))
      .filter(item => item.lines > 400)
    expect(tooLong).toEqual([])
  })

  it('入口 main.ts 只做装配：不直接读写业务表，不含导入逻辑', () => {
    const main = readFileSync(join(root, 'main.ts'), 'utf8')
    expect(lineCount(join(root, 'main.ts'))).toBeLessThan(120)
    expect(main).not.toMatch(/prisma\.(order|orderItem|fba\w+|ads\w+|syncJob|platformConnection)\./)
    expect(main).not.toMatch(/AmazonSpApiClient|AmazonAdsApiClient/)
  })

  it('导入器不依赖监听器与队列（方向：listeners → connectors → importers）', () => {
    for (const path of sourceFiles(join(root, 'importers')).filter(item => !item.endsWith('.test.ts'))) {
      const text = readFileSync(path, 'utf8')
      expect(text, path).not.toMatch(/from '(\.\.\/)+(listeners|runtime)\//)
      expect(text, path).not.toMatch(/from 'bullmq'/)
    }
  })
})
