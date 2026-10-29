import {
  DEFAULT_BUSINESS_RULES,
  DEFAULT_PROFIT_FORMULA,
  readBusinessRules,
  readFormulaConfig,
  type BusinessRulesConfig,
  type MetricVersionRef,
  type MetricVersionsInUse,
  type ProfitFormulaConfig,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from './prisma.service'

// 读取企业当前生效的口径版本（P6-31）：利润、库存、经营控制台等所有受口径影响的接口都从这里取，保证全站读同一个生效版本。
// 没有生效版本（或存储里的内容读不出来）时用系统默认配置，版本号为 0；默认配置与改版前的计算逐项一致。

type Db = PrismaService | Prisma.TransactionClient

export interface ActiveMetrics {
  formula: { config: ProfitFormulaConfig; ref: MetricVersionRef; effectiveFrom: Date | null }
  rules: { config: BusinessRulesConfig; ref: MetricVersionRef; effectiveFrom: Date | null }
  versions: MetricVersionsInUse
}

export async function loadActiveMetrics(db: Db, tenantId: string): Promise<ActiveMetrics> {
  const rows = await db.metricVersion.findMany({
    where: { tenantId, kind: { in: ['PROFIT_FORMULA', 'BUSINESS_RULES'] }, status: 'ACTIVE' },
    select: { kind: true, versionNo: true, config: true, effectiveFrom: true },
    take: 10,
  })
  const formulaRow = rows.find(row => row.kind === 'PROFIT_FORMULA')
  const rulesRow = rows.find(row => row.kind === 'BUSINESS_RULES')
  const formulaConfig = formulaRow ? readFormulaConfig(formulaRow.config) : null
  const rulesConfig = rulesRow ? readBusinessRules(rulesRow.config) : null
  const formula = {
    config: formulaConfig ?? { gross: [...DEFAULT_PROFIT_FORMULA.gross], denominator: [...DEFAULT_PROFIT_FORMULA.denominator] },
    ref: { kind: 'PROFIT_FORMULA', versionNo: formulaConfig && formulaRow ? formulaRow.versionNo : 0, source: formulaConfig ? 'VERSION' : 'DEFAULT' } as MetricVersionRef,
    effectiveFrom: formulaConfig && formulaRow ? formulaRow.effectiveFrom : null,
  }
  const rules = {
    config: rulesConfig ?? (structuredClone(DEFAULT_BUSINESS_RULES) as BusinessRulesConfig),
    ref: { kind: 'BUSINESS_RULES', versionNo: rulesConfig && rulesRow ? rulesRow.versionNo : 0, source: rulesConfig ? 'VERSION' : 'DEFAULT' } as MetricVersionRef,
    effectiveFrom: rulesConfig && rulesRow ? rulesRow.effectiveFrom : null,
  }
  return { formula, rules, versions: { profitFormula: formula.ref, businessRules: rules.ref } }
}
