import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Checkbox, Space, Tag } from 'antd'
import {
  FINANCE_POLICY_STEP_UP,
  FINANCE_POLICY_WRITE,
  FORMULA_KEYS,
  formulaIssues,
  type BridgeKey,
  type FormulaRowInfo,
  type MetricSubmitResult,
  type ProfitFormulaConfig,
  type ProfitFormulaResponse,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, PagedGrid, renderColumn, type ErpColDef, type PageFetcher } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { PendingAlert, VersionHistory } from '../settings/metric-versions-parts'

// 利润公式页（P6-31）：勾选哪些项目计入毛利润、哪些作为毛利率的分母。修改走“提交 → 别人审批 → 生效”，
// 审批通过后利润总览按新口径算；已关账月份的快照不改动。净利润与利润率不受这里影响。

const toggle = (list: readonly BridgeKey[], key: BridgeKey, on: boolean): BridgeKey[] => FORMULA_KEYS.filter(item => (item === key ? on : list.includes(item)))

export default function ProfitFormulaPage() {
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(current => current + 1), [])
  const query = useApiQuery<ProfitFormulaResponse>({ domain: 'config', path: '/finance/profit-formula', params: { tick } })
  const data = query.data ?? null
  const [draft, setDraft] = useState<ProfitFormulaConfig | null>(null)
  const config = draft ?? data?.current.config ?? null
  const issues = config ? formulaIssues(config) : []
  const dirty = config !== null && data !== null && (config.gross.join() !== data.current.config.gross.join() || config.denominator.join() !== data.current.config.denominator.join())
  const canEdit = data?.canWrite === true && data.pending === null

  const fetchRows = useCallback<PageFetcher<FormulaRowInfo>>(
    async ({ page, pageSize }) => {
      const rows = data?.rows ?? []
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
    },
    [data],
  )

  const columns = useMemo<ErpColDef<FormulaRowInfo>[]>(
    () => [
      renderColumn<FormulaRowInfo>('项目', 'label', row => row.label, { pin: 'left', width: 220, sortable: false }),
      renderColumn<FormulaRowInfo>(
        '方向',
        'direction',
        row =>
          row.direction === 'INCOME' ? (
            <Tag color="success" bordered={false}>
              收入
            </Tag>
          ) : row.direction === 'COST' ? (
            <Tag color="error" bordered={false}>
              支出
            </Tag>
          ) : (
            <Tag bordered={false}>结果</Tag>
          ),
        { width: 90, sortable: false },
      ),
      renderColumn<FormulaRowInfo>(
        '计入毛利润',
        'inGross',
        row => (
          <Checkbox
            aria-label={`计入毛利润：${row.label}`}
            disabled={!canEdit}
            checked={config?.gross.includes(row.key) ?? false}
            onChange={event => config && setDraft({ ...config, gross: toggle(config.gross, row.key, event.target.checked) })}
          />
        ),
        { width: 130, sortable: false },
      ),
      renderColumn<FormulaRowInfo>(
        '作为毛利率分母',
        'inDenominator',
        row => (
          <Checkbox
            aria-label={`作为毛利率分母：${row.label}`}
            disabled={!canEdit}
            checked={config?.denominator.includes(row.key) ?? false}
            onChange={event => config && setDraft({ ...config, denominator: toggle(config.denominator, row.key, event.target.checked) })}
          />
        ),
        { width: 150, sortable: false },
      ),
    ],
    [canEdit, config],
  )

  return (
    <div data-testid="profit-formula-page">
      <PageHeader
        title="利润公式"
        description="决定毛利润与毛利率怎么算。改动要提交、由另一位有权限的同事通过后才生效；净利润与利润率不受影响。"
        actions={
          <FormAction
            label="提交审批"
            title="提交利润公式修改"
            okText="提交"
            guard={{
              permission: FINANCE_POLICY_WRITE,
              condition: { ok: dirty && issues.length === 0 && data?.pending === null, reason: data?.pending ? '已有待审批的修改，请先处理' : (issues[0] ?? '还没有改动') },
            }}
            stepUp={FINANCE_POLICY_STEP_UP}
            reason={{ label: '修改原因' }}
            buttonProps={{ type: 'primary' }}
            description="提交后需要另一位有权限的同事通过才生效；通过前仍按当前口径计算。"
            successText="已提交，等待另一位有权限的同事审批"
            onSubmit={async values =>
              apiFetch<MetricSubmitResult>('/finance/profit-formula', {
                method: 'PUT',
                body: JSON.stringify({ version: data?.latestVersionNo ?? 0, gross: config?.gross, denominator: config?.denominator, reason: values.reason }),
              })
            }
            onDone={() => {
              setDraft(null)
              refresh()
            }}
          />
        }
      />
      {query.error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={query.error.message} /> : null}
      {data ? (
        <>
          <PendingAlert pending={data.pending} onDone={refresh} />
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            data-testid="formula-current"
            message={`当前口径：${data.current.source === 'DEFAULT' ? '系统默认' : `第 ${data.current.versionNo} 版`}`}
            description={
              <Space direction="vertical" size={2}>
                <span>{data.current.texts.gross}</span>
                <span>{data.current.texts.margin}</span>
                <Muted>{data.note}</Muted>
              </Space>
            }
          />
          {data.writeBlockedReason ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={data.writeBlockedReason} /> : null}
          {issues.length > 0 ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={issues.join('；')} /> : null}
        </>
      ) : null}
      <Card size="small" title="公式项目" style={{ marginBottom: 12 }}>
        <PagedGrid<FormulaRowInfo>
          gridId="finance.profitFormula.items"
          columns={columns}
          fetchPage={fetchRows}
          getRowId={row => row.key}
          resetKey={`${data?.latestVersionNo ?? 'x'}-${JSON.stringify(config)}-${canEdit}`}
          height={480}
          emptyState={{ kind: 'empty', domain: '利润公式项目', prerequisite: '正在读取公式项目。' }}
        />
      </Card>
      <Card size="small" title="版本历史">
        <VersionHistory kind="PROFIT_FORMULA" tick={tick} onDone={refresh} />
      </Card>
    </div>
  )
}
