import { useRef, useState } from 'react'
import { Alert, App, Button, Card, Collapse, Input, Select, Space, Tabs, Typography } from 'antd'
import { APLUS_ASIN_PATTERN, APLUS_STATUSES, APLUS_STATUS_LABEL, type AplusListResponse, type AplusRow, type AplusSort, type AplusStatus } from '@nova/api-contracts'
import { FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { formatNumber } from '../../format'
import { useAppNavigate } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { AplusEditorDrawer } from './AplusEditorDrawer'
import { AplusUploads } from './AplusUploads'
import { aplusColumns, detailTo } from './aplus-columns'
import { NONE_TEXT, PAGE_SIZES, SORT_FIELDS, SORT_LABEL, writeResultNote } from './aplus-format'
import { Basis, Muted, Pager, SectionNote, WriteButton, WriteNotice } from './aplus-ui'

// A+ 内容列表（P4-14，05 章 5.8）：内容、状态、关联 ASIN 数与进行中的写入；新建内容（结构化编辑器）与图片库。
// 数据来源：A+ 内容管理接口（每日同步）。筛选、排序、分页都在服务端（游标）；没有数据写“尚无记录”，没接入写“尚未接入”，不补 0。
// 所有写入都受写入开关“A+ 内容提交”控制，先登记再由后台任务发给亚马逊。

type Filters = { storeId?: string; status?: AplusStatus; q?: string; asin?: string }

function Summary({ data }: { data: AplusListResponse }) {
  const { total, byStatus, pending } = data.summary
  return (
    <Space wrap size={16} style={{ marginBottom: 8 }} data-testid="aplus-summary">
      {total > 0 ? (
        <>
          <span>
            共 <span className="erp-num">{formatNumber(total, { digits: 0 })}</span> 份
          </span>
          {APLUS_STATUSES.map(status => (
            <span key={status}>
              {APLUS_STATUS_LABEL[status]} {byStatus[status] > 0 ? <span className="erp-num">{formatNumber(byStatus[status], { digits: 0 })}</span> : <Muted>无</Muted>}
            </span>
          ))}
          <span>进行中写入 {pending > 0 ? <span className="erp-num">{formatNumber(pending, { digits: 0 })}</span> : <Muted>无</Muted>}</span>
        </>
      ) : (
        <span>{NONE_TEXT}</span>
      )}
    </Space>
  )
}

export default function AplusListPage() {
  const { message } = App.useApp()
  const go = useAppNavigate()
  const [tab, setTab] = useState('contents')
  const [filters, setFilters] = useState<Filters>({})
  const [asinError, setAsinError] = useState<string | null>(null)
  const [sort, setSort] = useState<AplusSort>('updatedAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[1])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [creating, setCreating] = useState(false)

  const reset = () => setStack([undefined])
  const apply = (patch: Partial<Filters>) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const query = useApiQuery<AplusListResponse>({ domain: 'list', path: '/aplus', params: { ...filters, sort: `${sort}:${dir}`, pageSize, cursor: stack[stack.length - 1] } })
  const data = query.data
  // 换条件重新读取期间，汇总与店铺选项沿用上一次的结果，避免整块闪烁；表格行与分页只用本次结果
  const last = useRef<AplusListResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(filters.q || filters.asin || filters.status || filters.storeId)
  const stores = shell?.stores ?? []

  const contents = (
    <>
      {shell ? <SectionNote state={shell.state} note={shell.note} remedyPath={shell.write.remedyPath} /> : null}
      {shell && (shell.state === 'OK' || shell.state === 'NO_DATA' || shell.summary.total > 0) ? <Summary data={shell} /> : null}
      <WriteNotice write={shell?.write} />
      <Space wrap style={{ marginBottom: 8 }}>
        <WriteButton label="新建 A+ 内容" type="primary" write={shell?.write} action={{ allowed: stores.length > 0, reason: '还没有接入可用的店铺，不能新建' }} onClick={() => setCreating(true)} />
        <Select
          allowClear
          virtual={false}
          style={{ width: 200 }}
          placeholder="全部店铺"
          aria-label="内容店铺"
          value={filters.storeId}
          options={stores.map(store => ({ value: store.id, label: store.name }))}
          onChange={value => apply({ storeId: value })}
        />
        <Select
          allowClear
          virtual={false}
          style={{ width: 140 }}
          placeholder="全部状态"
          aria-label="内容状态"
          value={filters.status}
          options={APLUS_STATUSES.map(value => ({ value, label: APLUS_STATUS_LABEL[value] }))}
          onChange={value => apply({ status: value })}
        />
        <Input.Search allowClear style={{ width: 220 }} placeholder="搜索内容名称" aria-label="搜索名称" onSearch={value => apply({ q: value.trim() || undefined })} />
        <Input.Search
          allowClear
          style={{ width: 200 }}
          placeholder="按关联的 ASIN 筛选"
          aria-label="按 ASIN 筛选"
          status={asinError ? 'error' : undefined}
          onSearch={value => {
            const asin = value.trim().toUpperCase()
            if (asin && !APLUS_ASIN_PATTERN.test(asin)) return setAsinError('ASIN 是 10 位字母或数字，例如 B0ABCDE123')
            setAsinError(null)
            apply({ asin: asin || undefined })
          }}
        />
        <Select
          virtual={false}
          value={sort}
          aria-label="排序字段"
          style={{ width: 200 }}
          options={SORT_FIELDS.map(field => ({ value: field, label: `按${SORT_LABEL[field]}排序` }))}
          onChange={field => {
            setSort(field)
            reset()
          }}
        />
        <Button
          aria-label="排序方向"
          onClick={() => {
            setDir(dir === 'desc' ? 'asc' : 'desc')
            reset()
          }}
        >
          {dir === 'desc' ? '从高到低' : '从低到高'}
        </Button>
        <Select
          virtual={false}
          value={String(pageSize)}
          aria-label="每页条数"
          style={{ width: 110 }}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => {
            setPageSize(Number(value))
            reset()
          }}
        />
      </Space>
      {asinError ? (
        <Typography.Text type="danger" role="alert" style={{ display: 'block', marginBottom: 8 }}>
          {asinError}
        </Typography.Text>
      ) : null}
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="内容很多，只统计并显示了最近更新的一部分；可以用筛选缩小范围" /> : null}
      <SimpleGrid<AplusRow>
        gridId="aplus.aplus-list-page"
        columns={aplusColumns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{
          kind: 'empty',
          domain: 'A+ 内容',
          prerequisite: filtered ? '没有符合条件的内容；可以放宽筛选条件。' : (data?.note ?? '还没有 A+ 内容；可以点“新建 A+ 内容”，或等待每日同步把亚马逊上已有的内容同步进来。'),
        }}
      />
      <Pager
        page={stack.length}
        hasNext={Boolean(next)}
        busy={query.isFetching}
        onPrev={() => setStack(current => current.slice(0, -1))}
        onNext={() => next && setStack(current => [...current, next])}
        note={data ? `本页 ${data.items.length} 条` : undefined}
      />
      {shell ? <Collapse ghost style={{ marginTop: 8 }} items={[{ key: 'basis', label: '数据口径说明', children: <Basis>{shell.basis}</Basis> }]} /> : null}
    </>
  )

  return (
    <div data-testid="aplus-page">
      <PageHeader
        title="A+ 内容"
        description="管理商品详情页的 A+ 内容：状态、关联 ASIN、审核结果与发布前后对照。内容来自亚马逊 A+ 内容管理接口（需要品牌备案与品牌内容角色），所有创建、修改、关联与提交审核都先登记，再由后台任务发给亚马逊。"
      />
      <FreshnessBar freshness={shell?.freshness ?? null} />
      <Card size="small" style={{ marginTop: 8 }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'contents', label: '内容列表', children: contents },
            { key: 'uploads', label: '图片库', children: <AplusUploads /> },
          ]}
        />
      </Card>
      <AplusEditorDrawer
        open={creating}
        stores={stores}
        onClose={() => setCreating(false)}
        onDone={result => {
          const note = writeResultNote(result)
          void (note.type === 'success' ? message.success(note.text) : message.warning(note.text))
          setCreating(false)
          if (result.contentId) go(detailTo(result.contentId))
        }}
      />
    </div>
  )
}
