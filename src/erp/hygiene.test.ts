import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 源码卫生检查（P1-07，01 章 1.3 第 1、2 条；14.5）：
// 生产代码里不能有演示数据、“规划中”占位文案、非美国站点；也不能有随机数据或假成功。
// 扫描范围：ERP 前端（src/erp）。过渡期旧页面已在 P5-12 删除。官网源码不在范围内。

const SRC = resolve(__dirname, '..')
const ROOTS = [join(SRC, 'erp')]

function walk(path: string, out: string[] = []): string[] {
  const stat = statSync(path)
  if (stat.isFile()) {
    out.push(path)
    return out
  }
  for (const name of readdirSync(path)) walk(join(path, name), out)
  return out
}

const files = ROOTS.flatMap(root => walk(root)).filter(file => /\.(ts|tsx|css)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file) && !file.includes(`${join('erp', 'test')}`))

const rules: Array<{ name: string; pattern: RegExp }> = [
  { name: '演示、示例数据字样', pattern: /演示|示例数据|示例记录|样例数据|模拟数据|假数据|demo data|mock data|sample data/i },
  { name: '规划中占位文案', pattern: /规划中|敬请期待|即将上线|开发中|coming soon/i },
  {
    name: '非美国站点',
    // 非美国站的亚马逊站点域名与站点编号（分两段书写，避免超长单行）
    pattern: new RegExp(
      [
        'Amazon\\.(co\\.uk|de|fr|it|es|ca|com\\.mx|co\\.jp|in|com\\.au|ae|sa|se|nl|pl|sg|com\\.br|com\\.tr)\\b',
        'A1F83G8C2ARO7P|A1PA6795UKMFR9|A13V1IB3VIYZZH|APJ6JRA9NG5V4|A1RKKUPIHCS9HS|A2EUQ1WTGCTBG2|A1AM78C64UM0Y8|A1VC38T7YXB528',
        'A39IBJ37TRP1C6|A21TJRUUN4KGV|A2VIGQ35RCS4UG|A17E79C6D8DWNP|A1805IZSGTT6HS|A2NODRKZP88ZB9|A33AVAJ2PDY3EV|A19VAU5U5O7RUS|A2Q3Y263D00KWC',
      ].join('|'),
    ),
  },
  { name: '随机生成的业务数据', pattern: /Math\.random\(\)/ },
  { name: '没有服务端调用的提示型假动作（Message.info）', pattern: /Message\.info\(/ },
  { name: '写死的上下文条（时区、币种、权限文案）', pattern: /US Eastern Time|由服务端权限返回|fba-context-strip/ },
]

describe('源码卫生', () => {
  it('扫描范围包含 ERP 前端', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  for (const rule of rules) {
    it(`不含${rule.name}`, () => {
      const hits: string[] = []
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/)
        lines.forEach((line, index) => {
          // 注释里可以写“不允许出现演示数据”这类说明，只检查会进入界面或数据的代码
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) return
          if (rule.pattern.test(line)) hits.push(`${relative(SRC, file)}:${index + 1}  ${line.trim().slice(0, 100)}`)
        })
      }
      expect(hits).toEqual([])
    })
  }

  it('旧代码已删除：演示数据、占位页、旧范围栏、旧驾驶舱、利润页、词级下钻页、过渡期页面与旧样式', () => {
    for (const gone of [
      'App.tsx',
      'data.ts',
      'data.test.ts',
      'erp/Placeholder.tsx',
      'erp/scope.tsx',
      'erp/Dashboard.tsx',
      'erp/ProfitPage.tsx',
      'erp/AdTermsPage.tsx',
      'FbaOperationsPage.tsx',
      'ProductionAdminPage.tsx',
      'fba-operations.css',
      'styles.css',
    ]) {
      expect(() => statSync(join(SRC, gone))).toThrow()
    }
  })

  it('依赖清单与源码里没有 Arco（P5-12 验收）', () => {
    const manifest = JSON.parse(readFileSync(resolve(SRC, '..', 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object }
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
    expect(declared.filter(name => /arco/i.test(name))).toEqual([])
    const users = walk(SRC)
      .filter(file => /\.(ts|tsx|css)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
      .filter(file => /@arco-design|arco-design\/web-react/.test(readFileSync(file, 'utf8')))
    expect(users.map(file => relative(SRC, file))).toEqual([])
  })
})
