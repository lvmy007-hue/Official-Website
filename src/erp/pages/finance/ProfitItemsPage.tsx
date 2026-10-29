import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Card, Form, Input, Select, Space, Tabs, Tag } from 'antd'
import {
  PROFIT_ITEM_GROUPS,
  PROFIT_ITEM_GROUP_LABEL,
  PROFIT_ITEM_MANAGE,
  type ProfitItemGroup,
  type ProfitItemRow,
  type ProfitItemsResponse,
  type ProfitItemsSaveResponse,
  type ProfitMappingRow,
  type ProfitUnmappedResponse,
  type ProfitUnmappedRow,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, PagedGrid, renderColumn, RIGHT_ALIGNED, type ErpColDef, type PageFetcher } from '../../components'
import { Muted } from '../inventory/inventory-ui'
import { descendantsOf, flattenItems, ItemPicker, newItemRow, type Draft } from './profit-items-draft'

// 利润项目字典（P6-18，16 章第 7 节）：三层“原始交易类型 → 二级项目 → 一级项目”。
// 改动先在本页暂存（项目树、交易类型映射），点“保存字典”才一次写入并生成新版本；别人先保存会提示冲突，刷新后重做。
// 保存后的新口径在利润日表下一次重算（每 6 小时近 45 天）后生效；已关账的期间不受影响。没有映射的交易类型仍按内置口径计入利润，在“未映射”里提醒补全。

const GUARD = { permission: PROFIT_ITEM_MANAGE } as const
export default function ProfitItemsPage() {
  const [server, setServer] = useState<ProfitItemsResponse | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<'items' | 'mappings' | 'unmapped'>('items')
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      const response = await apiFetch<ProfitItemsResponse>('/finance/profit-items')
      setServer(response)
      setDraft({ items: response.items, mappings: response.mappings })
      setDirty(false)
      setLoadError(null)
      setTick(current => current + 1)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取失败')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const change = useCallback((next: (current: Draft) => Draft) => {
    setDraft(current => (current ? next(current) : current))
    setDirty(true)
    setTick(current => current + 1)
  }, [])

  const items = useMemo(() => draft?.items ?? [], [draft])
  const flat = useMemo(() => flattenItems(items), [items])
  const nameOf = useCallback((id: string) => items.find(item => item.id === id)?.name ?? '（已删除）', [items])
  const limits = server?.limits

  const addItem = useCallback(
    (parent: ProfitItemRow | null, name: string, group: ProfitItemGroup | null) => change(current => ({ ...current, items: [...current.items, newItemRow(current.items, parent, name, group)] })),
    [change],
  )
  const itemColumns = useMemo<ErpColDef<ProfitItemRow>[]>(
    () => [
      renderColumn<ProfitItemRow>('项目', 'name', row => <span style={{ paddingLeft: (row.level - 1) * 20 }}>{row.name}</span>, { group: '项目', pin: 'left', width: 260, sortable: false }),
      renderColumn<ProfitItemRow>('分组', 'groupLabel', row => row.groupLabel, { group: '项目', width: 110, sortable: false }),
      renderColumn<ProfitItemRow>(
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
        { group: '项目', width: 90, sortable: false },
      ),
      renderColumn<ProfitItemRow>('映射的交易类型', 'mappedTypes', row => (row.acceptsMapping ? <span className="erp-num">{row.mappedTypes}</span> : <Muted>不接收交易</Muted>), {
        group: '现状',
        width: 140,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
      renderColumn<ProfitItemRow>('近 30 天笔数', 'txCount30d', row => <span className="erp-num">{row.txCount30d}</span>, { group: '现状', width: 120, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<ProfitItemRow>(
        '操作',
        'actions',
        row => (
          <Space size={4}>
            <FormAction
              label="改名"
              title={`修改项目名称：${row.name}`}
              okText="确定"
              guard={GUARD}
              buttonProps={{ size: 'small' }}
              initialValues={{ name: row.name }}
              onSubmit={async values => change(current => ({ ...current, items: current.items.map(item => (item.id === row.id ? { ...item, name: String(values.name).trim() } : item)) }))}
            >
              <Form.Item
                name="name"
                label="项目名称"
                rules={[
                  { required: true, whitespace: true, message: '请填写项目名称' },
                  { max: limits?.nameMax ?? 40, message: `最多 ${limits?.nameMax ?? 40} 个字` },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
            </FormAction>
            {row.level < (limits?.maxDepth ?? 3) ? (
              <FormAction
                label="新增子项目"
                title={`在 ${row.name} 下新增子项目`}
                okText="新增"
                guard={GUARD}
                buttonProps={{ size: 'small' }}
                onSubmit={async values => addItem(row, String(values.name).trim(), null)}
              >
                <Form.Item
                  name="name"
                  label="项目名称"
                  rules={[
                    { required: true, whitespace: true, message: '请填写项目名称' },
                    { max: limits?.nameMax ?? 40, message: `最多 ${limits?.nameMax ?? 40} 个字` },
                  ]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
              </FormAction>
            ) : null}
            {row.isSystem ? null : (
              <FormAction
                label="删除"
                title={`删除项目：${row.name}`}
                okText="删除"
                danger
                guard={GUARD}
                buttonProps={{ size: 'small' }}
                description="子项目一起删除，指向它们的交易类型变为未映射（仍按内置口径计入利润）。点“保存字典”后才真正生效。"
                onSubmit={async () =>
                  change(current => {
                    const gone = descendantsOf(current.items, row.id)
                    return { items: current.items.filter(item => !gone.has(item.id)), mappings: current.mappings.filter(mapping => !gone.has(mapping.itemId)) }
                  })
                }
              />
            )}
          </Space>
        ),
        { group: '操作', pin: 'right', width: 260, sortable: false },
      ),
    ],
    [addItem, change, limits],
  )

  const fetchItems = useCallback<PageFetcher<ProfitItemRow>>(async ({ page, pageSize }) => ({ items: flat.slice((page - 1) * pageSize, page * pageSize), total: flat.length }), [flat])

  const mappingColumns = useMemo<ErpColDef<ProfitMappingRow>[]>(
    () => [
      renderColumn<ProfitMappingRow>('交易类型', 'label', row => row.label, { group: '交易类型', pin: 'left', width: 320, sortable: false }),
      renderColumn<ProfitMappingRow>('编码', 'transactionType', row => <span className="erp-num">{row.transactionType}</span>, { group: '交易类型', width: 260, sortable: false }),
      renderColumn<ProfitMappingRow>('归到项目', 'itemId', row => nameOf(row.itemId), { group: '归属', width: 200, sortable: false }),
      renderColumn<ProfitMappingRow>('近 30 天笔数', 'txCount30d', row => <span className="erp-num">{row.txCount30d}</span>, { group: '现状', width: 120, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<ProfitMappingRow>(
        '操作',
        'actions',
        row => (
          <FormAction
            label="改映射"
            title={`改归属：${row.label}`}
            okText="确定"
            guard={GUARD}
            buttonProps={{ size: 'small' }}
            initialValues={{ itemId: row.itemId }}
            onSubmit={async values =>
              change(current => ({
                ...current,
                mappings: current.mappings.map(mapping => (mapping.transactionType === row.transactionType ? { ...mapping, itemId: String(values.itemId) } : mapping)),
              }))
            }
          >
            <ItemPicker items={items} name="itemId" />
          </FormAction>
        ),
        { group: '操作', pin: 'right', width: 110, sortable: false },
      ),
    ],
    [change, items, nameOf],
  )

  const fetchMappings = useCallback<PageFetcher<ProfitMappingRow>>(
    async ({ page, pageSize }) => {
      const rows = draft?.mappings ?? []
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }
    },
    [draft],
  )

  const unmappedColumns = useMemo<ErpColDef<ProfitUnmappedRow>[]>(
    () => [
      renderColumn<ProfitUnmappedRow>('交易类型', 'label', row => row.label, { group: '交易类型', pin: 'left', width: 320, sortable: false }),
      renderColumn<ProfitUnmappedRow>('编码', 'transactionType', row => <span className="erp-num">{row.transactionType}</span>, { group: '交易类型', width: 260, sortable: false }),
      renderColumn<ProfitUnmappedRow>('现在按内置口径归到', 'defaultItemName', row => row.defaultItemName, { group: '现状', width: 200, sortable: false }),
      renderColumn<ProfitUnmappedRow>('近 30 天笔数', 'txCount30d', row => <span className="erp-num">{row.txCount30d}</span>, { group: '现状', width: 120, ...RIGHT_ALIGNED }),
      renderColumn<ProfitUnmappedRow>(
        '操作',
        'actions',
        row => (
          <FormAction
            label="映射到…"
            title={`补全映射：${row.label}`}
            okText="确定"
            guard={GUARD}
            buttonProps={{ size: 'small' }}
            initialValues={{ itemId: row.defaultItemId ?? undefined }}
            onSubmit={async values => {
              change(current => ({
                ...current,
                mappings: [
                  ...current.mappings.filter(mapping => mapping.transactionType !== row.transactionType),
                  { transactionType: row.transactionType, label: row.label, itemId: String(values.itemId), txCount30d: row.txCount30d },
                ],
              }))
              setTab('mappings')
            }}
          >
            <ItemPicker items={items} name="itemId" />
          </FormAction>
        ),
        { group: '操作', pin: 'right', width: 120, sortable: false },
      ),
    ],
    [change, items],
  )

  const fetchUnmapped = useCallback<PageFetcher<ProfitUnmappedRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<ProfitUnmappedResponse>(`/finance/profit-items/unmapped?page=${page}&pageSize=${pageSize}`, { signal })
      const mapped = new Set((draft?.mappings ?? []).map(mapping => mapping.transactionType))
      return { items: response.items.filter(row => !mapped.has(row.transactionType)), total: response.total }
    },
    [draft],
  )

  const body =
    draft && server
      ? {
          version: server.version,
          items: flat.map((item, index) => ({
            id: item.id,
            parentId: item.parentId,
            name: item.name,
            sort: item.sort ?? index,
            ...(item.isSystem ? {} : { sign: item.sign, ...(item.parentId === null ? { group: item.group } : {}) }),
          })),
          mappings: draft.mappings.map(mapping => ({ transactionType: mapping.transactionType, itemId: mapping.itemId })),
        }
      : null

  return (
    <div data-testid="profit-items-page">
      <PageHeader title="利润项目字典" description="决定利润分析里每笔交易归到哪个项目：原始交易类型 → 二级项目 → 一级项目，最多三级。系统项目不能删除，可以改名；自定义项目可以增删改。" />
      {server ? <Alert type="info" showIcon style={{ marginBottom: 12 }} data-testid="profit-items-note" message={server.note} /> : null}
      {loadError ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadError} /> : null}
      {server?.manageBlockedReason ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={server.manageBlockedReason} /> : null}
      <Card size="small">
        {server ? (
          <Space size={8} wrap style={{ marginBottom: 8 }} data-testid="profit-items-summary">
            <Tag bordered={false}>{`字典版本 ${server.version}`}</Tag>
            <Muted>{`${items.length} / ${server.limits.maxItems} 个项目；${draft?.mappings.length ?? 0} 个交易类型已映射；近 30 天 ${server.totalTxCount30d} 笔交易`}</Muted>
            {server.unmappedCount > 0 ? <Tag color="warning" bordered={false}>{`还有 ${server.unmappedCount} 个交易类型未映射`}</Tag> : null}
            {dirty ? (
              <Tag color="processing" bordered={false}>
                有未保存的改动
              </Tag>
            ) : null}
            <FormAction
              label="新增一级项目"
              title="新增一级项目"
              okText="新增"
              guard={GUARD}
              initialValues={{ group: 'OTHER' }}
              onSubmit={async values => addItem(null, String(values.name).trim(), values.group as ProfitItemGroup)}
            >
              <Form.Item
                name="name"
                label="项目名称"
                rules={[
                  { required: true, whitespace: true, message: '请填写项目名称' },
                  { max: server.limits.nameMax, message: `最多 ${server.limits.nameMax} 个字` },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="group" label="分组" rules={[{ required: true }]}>
                <Select options={PROFIT_ITEM_GROUPS.map(value => ({ value, label: PROFIT_ITEM_GROUP_LABEL[value] }))} />
              </Form.Item>
            </FormAction>
            <FormAction
              label="保存字典"
              title="保存利润项目字典"
              okText="保存"
              guard={GUARD}
              buttonProps={{ type: 'primary', title: dirty ? undefined : '还没有改动' }}
              description="保存后生成新的字典版本；新口径在利润日表下一次重算后生效，已关账的期间不受影响。"
              successText="字典已保存"
              onSubmit={async () => {
                const result = await apiFetch<ProfitItemsSaveResponse>('/finance/profit-items', { method: 'PUT', body: JSON.stringify(body) })
                return result
              }}
              onDone={() => void load()}
            />
          </Space>
        ) : null}
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as typeof tab)}
          items={[
            { key: 'items', label: '项目树' },
            { key: 'mappings', label: '交易类型映射' },
            { key: 'unmapped', label: `未映射${server && server.unmappedCount > 0 ? `（${server.unmappedCount}）` : ''}` },
          ]}
        />
        {draft ? (
          tab === 'items' ? (
            <PagedGrid<ProfitItemRow>
              gridId="finance.profitItems.items"
              columns={itemColumns}
              fetchPage={fetchItems}
              getRowId={row => row.id}
              resetKey={String(tick)}
              emptyState={{ kind: 'empty', domain: '利润项目', prerequisite: '字典会在第一次打开本页时自动生成。' }}
              height={460}
            />
          ) : tab === 'mappings' ? (
            <PagedGrid<ProfitMappingRow>
              gridId="finance.profitItems.mappings"
              columns={mappingColumns}
              fetchPage={fetchMappings}
              getRowId={row => row.transactionType}
              resetKey={String(tick)}
              emptyState={{ kind: 'empty', domain: '交易类型映射', prerequisite: '店铺同步到费用明细后，这里会列出已映射的交易类型。' }}
              height={460}
            />
          ) : (
            <PagedGrid<ProfitUnmappedRow>
              gridId="finance.profitItems.unmapped"
              columns={unmappedColumns}
              fetchPage={fetchUnmapped}
              getRowId={row => row.transactionType}
              resetKey={String(tick)}
              emptyState={{ kind: 'empty', domain: '未映射的交易类型', prerequisite: '最近 90 天出现过的交易类型都已有映射。' }}
              height={460}
            />
          )
        ) : null}
      </Card>
    </div>
  )
}
