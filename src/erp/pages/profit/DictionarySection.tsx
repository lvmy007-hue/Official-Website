import { useCallback, useMemo } from 'react'
import { Alert, Tag } from 'antd'
import type { ProfitDictionaryRow, ProfitDictionaryView } from '@nova/api-contracts'
import { PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { formatMoney } from '../../format'
import { Muted } from '../inventory/inventory-ui'

// 利润总览里“按项目字典”的拆分（P6-18）：一级项目、二级项目逐行显示对净利润的带符号贡献（收入为正、花费为负），
// 合计与上面的利润桥、净利润对得上；对不上时明确提示。代收代缴税只展示不计入；没有映射的交易类型单列“未映射”。

const SOURCE_TEXT: Record<ProfitDictionaryRow['source'], string> = { TRANSACTIONS: '交易明细', COLUMN: '利润日表', MIXED: '交易明细与利润日表', NONE: '—' }
const money = (value: number | null) => (value === null ? <Muted>无数据</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>)

export function DictionarySection({ view }: { view: ProfitDictionaryView }) {
  const columns = useMemo<ErpColDef<ProfitDictionaryRow>[]>(
    () => [
      renderColumn<ProfitDictionaryRow>('项目', 'name', row => <span style={{ paddingLeft: (row.level - 1) * 20, fontWeight: row.level === 1 ? 600 : undefined }}>{row.name}</span>, {
        group: '项目',
        pin: 'left',
        width: 260,
        sortable: false,
      }),
      renderColumn<ProfitDictionaryRow>('自己的金额', 'own', row => (row.excluded ? <Muted>不计入利润</Muted> : money(row.own)), { group: '金额', width: 150, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<ProfitDictionaryRow>('含子项目合计', 'total', row => (row.excluded ? <Muted>—</Muted> : money(row.total)), { group: '金额', width: 150, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<ProfitDictionaryRow>('来源', 'source', row => SOURCE_TEXT[row.source], { group: '口径', width: 170, sortable: false }),
      renderColumn<ProfitDictionaryRow>(
        '类型',
        'isSystem',
        row =>
          row.isSystem ? (
            <Tag bordered={false}>系统</Tag>
          ) : (
            <Tag color="processing" bordered={false}>
              自定义
            </Tag>
          ),
        { group: '口径', width: 90, sortable: false },
      ),
    ],
    [],
  )
  const fetchPage = useCallback<PageFetcher<ProfitDictionaryRow>>(
    async ({ page, pageSize }) => ({ items: view.rows.slice((page - 1) * pageSize, page * pageSize), total: view.rows.length }),
    [view.rows],
  )
  return (
    <div data-testid="profit-dictionary" style={{ margin: '12px 0' }}>
      <h4 style={{ margin: '0 0 8px' }}>按利润项目字典拆分（字典版本 {view.version}）</h4>
      {view.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={view.note} /> : null}
      {view.balanced === false ? (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} data-testid="profit-dictionary-unbalanced" message="按字典拆开的合计与净利润对不上，请先核对利润日表是否正在重算，再联系管理员。" />
      ) : null}
      <PagedGrid<ProfitDictionaryRow>
        gridId="profit.overview.dictionary"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={`${view.version}:${view.rows.length}`}
        emptyState={{ kind: 'empty', domain: '利润项目', prerequisite: '字典会在第一次打开利润项目字典页时生成。' }}
        height={380}
      />
      <p style={{ marginTop: 8 }}>
        <Muted>
          {`未映射部分 ${view.unmappedAmount === null ? '无' : formatMoney(view.unmappedAmount, 'USD', { digits: 2 })}；拆分合计 ${view.total === null ? '无数据' : formatMoney(view.total, 'USD', { digits: 2 })}${view.balanced === true ? '，与净利润一致' : ''}`}
        </Muted>
      </p>
    </div>
  )
}
