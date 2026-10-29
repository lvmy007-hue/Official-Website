import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ERP, ROOT, importClosure, livePageFiles, manifestComponents, productionFiles, rel, sourceText } from './acceptance-scan.test-helper'

// 全站验收（P5-14，11 章 11.6 与 09 章）：把能用代码核对的验收条目固定成测试，防止以后回退。
// 需要真实店铺、真实浏览器或人工判断的条目不在这里，见 docs/acceptance/p5-14-acceptance-report.md。

const pages = livePageFiles()
const manifestText = readFileSync(join(ERP, 'routes', 'manifest.generated.ts'), 'utf8')

/** 在生产代码里逐行找命中（跳过注释行），返回“文件:行号 内容”。 */
function hits(files: string[], pattern: RegExp): string[] {
  const out: string[] = []
  for (const file of files) {
    sourceText(file)
      .split(/\r?\n/)
      .forEach(line => {
        if (pattern.test(line)) out.push(`${rel(file)}  ${line.trim().slice(0, 100)}`)
      })
  }
  return out
}

describe('11.6 第 1 条：没有写死的日期', () => {
  it('ERP 前端生产代码里没有年月日或年月字面量（占位提示用 YYYY-MM 这类格式写法）', () => {
    expect(hits(productionFiles(ERP), /['"`]20[12]\d-\d\d/)).toEqual([])
  })
})

describe('11.6 第 2 条：没有通用表格页承载多个业务域', () => {
  // P6-30：阶段 6 路由必须已经挂上页面。识别规则失效时先报数量不对，不会静默放过缺页面。
  const stage6 = new Set([...manifestText.matchAll(/"component":"(\w+)","access":\{[^}]*\},"stage":"6"/g)].map(hit => hit[1]))

  it('路由清单里的租户页面全部已上线；其余 7 个是登录、邀请、初始化与平台后台页，由路由文件直接承载', () => {
    const missing = manifestComponents().filter(name => !pages.has(name))
    expect(missing.sort()).toEqual(['InviteAcceptPage', 'LoginPage', 'OnboardingPage', 'PlatformLoginPage', 'PlatformSupportAccessPage', 'PlatformTenantDetailPage', 'PlatformTenantsPage'].sort())
  })

  it('阶段 6 的 24 个路由都已登记页面', () => {
    expect(stage6.size).toBe(24)
    expect([...stage6].filter(name => !pages.has(name)).sort()).toEqual([])
  })

  it('每个页面组件对应各自的模块文件，不存在两个路由共用一个页面模块', () => {
    const byFile = new Map<string, string[]>()
    for (const [name, file] of pages) byFile.set(file, [...(byFile.get(file) ?? []), name])
    const shared = [...byFile].filter(([, names]) => names.length > 1).map(([file, names]) => `${rel(file)} ← ${names.join('、')}`)
    expect(shared).toEqual([])
  })
})

describe('11.6 第 4 条：每个页面都有加载态、空态与错误态的承载', () => {
  // 只看页面自己的目录（src/erp/pages）：共享组件里的状态不算页面自己接入了状态；
  // `error={...}`、`loading={...}` 是交给 SimpleTable、ChartPanel 这类共享组件，由它们渲染错误态与骨架屏；
  // PagedGrid / MassiveGrid（阶段 6 表格骨架）自己渲染骨架屏、错误态（带重试）和必填的 emptyState。
  const LOADING = /kind="skeleton"|kind: 'skeleton'|Skeleton|<Spin\b|loading=\{|isLoading|isPending|StateBlock|ResultView|LazyResult|<PagedGrid\b|<MassiveGrid\b/
  const EMPTY = /kind="empty"|kind: 'empty'|emptyState|尚无记录|暂无|StateBlock|<Empty\b|emptyText|<PagedGrid\b|<MassiveGrid\b/
  const ERROR = /stateFromError|server-error|describeError|isError|error=\{|StateBlock|ResultView|ErrorState|<PagedGrid\b|<MassiveGrid\b/
  for (const [name, file] of pages) {
    it(`${name}`, () => {
      const text = importClosure(file)
        .filter(item => rel(item).startsWith('src/erp/pages/'))
        .map(sourceText)
        .join('\n')
      const missing = [
        ['加载态', LOADING],
        ['空态', EMPTY],
        ['错误态', ERROR],
      ].filter(([, pattern]) => !(pattern as RegExp).test(text))
      expect(
        missing.map(([label]) => label),
        rel(file),
      ).toEqual([])
    })
  }
})

describe('11.6 第 5 条：页面不混入自发货流程', () => {
  it('没有自发货的履约流程用语（待发货队列的“分配履约人”“内部时效”、轻小件配送、多渠道配送与外部履约）', () => {
    const files = [...productionFiles(ERP), ...productionFiles(join(ROOT, 'apps', 'api', 'src')), ...productionFiles(join(ROOT, 'apps', 'worker', 'src')), ...productionFiles(join(ROOT, 'packages'))]
    expect(hits(files, /分配履约|履约人|内部时效|Easy ?Ship|confirmShipment|MerchantFulfillment|多渠道配送|外部履约/i)).toEqual([])
  })
})

describe('11.6 第 12 条：美国站入仓没有由亚马逊预处理或贴标的选项', () => {
  it('入仓相关代码里预处理方与贴标方只有固定写法，没有可传入的字段、默认值或“AMAZON”取值', () => {
    const files = [...productionFiles(ERP), ...productionFiles(join(ROOT, 'apps', 'api', 'src')), ...productionFiles(join(ROOT, 'apps', 'worker', 'src')), ...productionFiles(join(ROOT, 'packages'))]
    // 可选字段（prepOwner?:）、取默认值（prepOwner ??）、取值为亚马逊（prepOwner: 'AMAZON'）都不允许
    expect(hits(files, /(prepOwner|labelOwner)\s*(\?:|\?\?)|(prepOwner|labelOwner)['"]?\s*[:=]\s*['"](AMAZON|NONE)['"]/)).toEqual([])
  })
})

describe('09 章：15 个小节对应的页面都已上线', () => {
  const sections: Array<[string, string]> = [
    ['9.1 风险预警中心', '/app/alerts'],
    ['9.1 预警详情', '/app/alerts/:id'],
    ['9.1 预警规则', '/app/alerts/rules'],
    ['9.2 账户健康', '/app/account-health'],
    ['9.3 报表中心', '/app/reports'],
    ['9.3 报告任务详情', '/app/reports/:id'],
    ['9.4 导出中心', '/app/my/exports'],
    ['9.5 指标口径', '/app/help/metrics'],
    ['9.6 连接中心', '/app/connections'],
    ['9.7 消息推送订阅', '/app/connections/notifications'],
    ['9.8 同步中心', '/app/sync'],
    ['9.8 同步任务详情', '/app/sync/:id'],
    ['9.9 法律主体', '/app/entities'],
    ['9.9 法律主体详情', '/app/entities/:id'],
    ['9.10 成员', '/app/members'],
    ['9.10 成员详情', '/app/members/:id'],
    ['9.10 角色编辑器', '/app/roles'],
    ['9.11 审计中心', '/app/audit'],
    ['9.11 审计详情', '/app/audit/:id'],
    ['9.12 企业设置', '/app/settings'],
    ['9.13 接口与写入开关', '/app/settings/integrations'],
    ['9.14 汇率', '/app/settings/fx'],
    ['9.15 个人账号', '/app/profile'],
    ['9.15 消息中心', '/app/my/notifications'],
  ]
  for (const [label, path] of sections) {
    it(label, () => {
      const hit = new RegExp(`"path":"${path.replace(/[/:]/g, m => (m === '/' ? '\\/' : ':'))}","title":"[^"]*","group":"[^"]*","component":"(\\w+)"`).exec(manifestText)
      expect(hit, `${path} 不在路由清单里`).not.toBeNull()
      expect(pages.has(hit![1]), `${path} 的页面 ${hit![1]} 没有上线`).toBe(true)
    })
  }
})
