import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = __dirname
const MODULES = join(SRC, 'modules')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
}

const SUPPORT_MODULES = ['approval-registry']
const moduleNames = readdirSync(MODULES).filter(name => statSync(join(MODULES, name)).isDirectory())

describe('领域模块边界（P1-10）', () => {
  it('每个领域模块都有模块、控制器、服务与对外入口', () => {
    for (const name of moduleNames) {
      const files = readdirSync(join(MODULES, name))
      expect(files, `${name} 缺少 index.ts`).toContain('index.ts')
      expect(
        files.some(f => f.endsWith('.module.ts')),
        `${name} 缺少 *.module.ts`,
      ).toBe(true)
      // 支撑模块（只被其他模块引用、没有自己的接口）不要求控制器：approval-registry 是审批登记与回写（P6-27），接口在 approvals 模块
      if (!SUPPORT_MODULES.includes(name)) {
        expect(
          files.some(f => f.endsWith('.controller.ts')),
          `${name} 缺少 *.controller.ts`,
        ).toBe(true)
      }
      expect(
        files.some(f => f.endsWith('.service.ts')),
        `${name} 缺少 *.service.ts`,
      ).toBe(true)
    }
  })

  it('每个领域模块至少有一份测试', () => {
    for (const name of moduleNames) {
      const hasTest = walk(join(MODULES, name)).some(f => f.endsWith('.test.ts'))
      expect(hasTest, `${name} 没有测试`).toBe(true)
    }
  })

  it('跨模块只能引用对方的对外入口（index.ts），不得引用内部文件', () => {
    const violations: string[] = []
    for (const name of moduleNames) {
      for (const file of walk(join(MODULES, name)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
        for (const spec of importsOf(file)) {
          const match = /^\.\.\/([a-z-]+)(\/.*)?$/.exec(spec)
          if (!match) continue
          const [, target, rest] = match
          if (target === name) continue
          if (target === '..' || !moduleNames.includes(target)) continue
          if (rest) violations.push(`${relative(SRC, file)} → ${spec}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('基础设施层不依赖任何领域模块，领域模块不依赖应用根', () => {
    const bad: string[] = []
    for (const file of walk(join(SRC, 'platform')).filter(f => f.endsWith('.ts'))) {
      for (const spec of importsOf(file)) if (spec.includes('modules')) bad.push(`${relative(SRC, file)} → ${spec}`)
    }
    for (const file of walk(MODULES).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      for (const spec of importsOf(file)) if (spec.endsWith('app.module')) bad.push(`${relative(SRC, file)} → ${spec}`)
    }
    expect(bad).toEqual([])
  })

  it('列表分页统一使用查询契约：不得自行解析页码与页大小（P1-11）', () => {
    const offenders = walk(MODULES)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter(f => /Number\(query\.page|Number\(query\.pageSize|Math\.min\(\s*\d+\s*,\s*Math\.max\([^)]*pageSize/.test(readFileSync(f, 'utf8')))
      .map(f => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('业务代码不直接引用令牌解密或买家信息解密能力', () => {
    const offenders = walk(SRC)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes(`${sep}testing${sep}`))
      .filter(f => /createDecipheriv|openPii/.test(readFileSync(f, 'utf8')))
      .map(f => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('密钥环只能在 secret-box.service.ts 里使用；接口服务不解密亚马逊令牌与买家信息（P1-24）', () => {
    const files = walk(SRC).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes(`${sep}testing${sep}`))
    const keyringUsers = files.filter(f => /from '@nova\/crypto'/.test(readFileSync(f, 'utf8'))).map(f => relative(SRC, f).split(sep).join('/'))
    // main.ts 只用它校验“主密钥配置是否合法”（生产环境启动检查），不创建密钥环
    expect(keyringUsers).toEqual(['main.ts', 'platform/security/secret-box.service.ts'])
    expect(readFileSync(join(SRC, 'main.ts'), 'utf8')).not.toMatch(/\bKeyring\b/)
    const service = readFileSync(join(SRC, 'platform', 'security', 'secret-box.service.ts'), 'utf8')
    // 亚马逊令牌只允许出现在“加密”调用里；买家信息接口服务从不加密，解密只有 openBuyerPii 一处（P2b-01，见下一条）
    expect(service).not.toMatch(/\.open\(\s*'amazon-token'/)
    expect(service).not.toMatch(/\.seal\(\s*'buyer-pii'/)
    expect(service.match(/\.open\(\s*'buyer-pii'/g)).toHaveLength(1)
  })

  it('买家信息解密只有个人信息统一出口（modules/pii）一个调用方（P2b-01、P6-14）', () => {
    const callers = walk(SRC)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes(`${sep}testing${sep}`))
      .filter(f => /\bopenBuyerPii\b/.test(readFileSync(f, 'utf8')))
      .map(f => relative(SRC, f).split(sep).join('/'))
      .sort()
    expect(callers).toEqual(['modules/pii/pii-reveal.service.ts', 'platform/security/secret-box.service.ts'])
  })

  it('个人信息来源只交出存储的内容：不解密、不写审计；统一出口控制器只有一条路由（P6-14）', () => {
    for (const file of walk(MODULES).filter(f => /-pii-source\.ts$/.test(f))) {
      const text = readFileSync(file, 'utf8')
      expect(text, relative(SRC, file)).not.toMatch(/SecretBoxService|openBuyerPii|AuditWriter/)
    }
    const controller = readFileSync(join(MODULES, 'pii', 'pii.controller.ts'), 'utf8')
    expect(controller.match(/@(Get|Post|Put|Patch|Delete)\(/g)).toEqual(['@Post('])
    expect(controller).toContain("@Post('reveal')")
  })
})
