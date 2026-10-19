import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Message } from '@arco-design/web-react'
import { apiFetch, isServerMode } from './api'
import './fba-operations.css'

export type FbaModule = 'overview' | 'orders' | 'products' | 'inventory' | 'inbound' | 'warehouse' | 'fees' | 'returns' | 'sync' | 'connections' | 'reports'
type Row = Record<string, unknown>

type ModuleMeta = { title: string; kicker: string; subtitle: string; endpoint?: string; primary?: string }

const META: Record<FbaModule, ModuleMeta> = {
  overview: { title: 'FBA 运营控制台', kicker: 'AMAZON.COM · FBA OPERATIONS', subtitle: '以待办、状态和可执行对象组织每日运营，不用图表代替业务动作。', primary: '创建同步任务' },
  orders: { title: 'FBA 订单', kicker: 'ORDERS · FBA FULFILLMENT', subtitle: '订单头、订单行、履约中心、配送承诺、承运商和退货关联进入同一条记录链。', endpoint: '/orders', primary: '同步订单' },
  products: { title: 'ASIN / SKU 主数据', kicker: 'CATALOG · LISTINGS · COMPLIANCE', subtitle: 'ASIN、Seller SKU、FNSKU、尺寸段、刊登状态和履约标识的统一对象台。', endpoint: '/fba/products', primary: '同步商品目录' },
  inventory: { title: 'FBA 库存健康', kicker: 'FBA INVENTORY · HEALTH', subtitle: 'Sellable、Reserved、Inbound、Unfulfillable、库龄和 Days of Supply 进入同一张可处理清单。', endpoint: '/fba/inventory', primary: '创建补货计划' },
  inbound: { title: '采购与 FBA 入库', kicker: 'SUPPLY CHAIN · INBOUND', subtitle: '从补货建议到 Inbound Plan、Shipment、运输、标签、FC 接收和差异核对的执行台。', endpoint: '/fba/inbound-plans', primary: '创建入仓计划' },
  warehouse: { title: 'FBA 货件与仓库', kicker: 'FULFILLMENT CENTER · RECEIVING', subtitle: '按 Fulfillment Center 管理货件接收、追踪、数量差异和后续赔付证据。', endpoint: '/fba/inbound-plans', primary: '创建 FBA 货件' },
  fees: { title: 'FBA 费用与结算', kicker: 'FINANCES · SETTLEMENT', subtitle: '把履约费、仓储费、入仓配置费、库龄费、移除/弃置和赔付拆成可对账事件。', endpoint: '/fba/fees', primary: '生成费用报表' },
  returns: { title: 'FBA 退货与赔付', kicker: 'RETURNS · REIMBURSEMENTS', subtitle: '围绕订单、ASIN、Disposition、退款、不可售库存和赔付案件处理异常。', endpoint: '/fba/returns', primary: '生成退货报表' },
  sync: { title: 'FBA 同步任务', kicker: 'DATA PIPELINE · JOBS', subtitle: '每个数据域都有独立任务、进度、失败原因、request ID 和人工重试入口。', endpoint: '/sync/jobs', primary: '创建同步任务' },
  connections: { title: 'Amazon US 连接', kicker: 'AUTHORIZATION · HEALTH', subtitle: 'Seller Central、SP-API、Ads 的授权范围、健康检查和数据入口清晰分开。', endpoint: '/connections', primary: '发起授权' },
  reports: { title: 'FBA 经营报表', kicker: 'REPORTS · EVIDENCE', subtitle: '报表请求、生成、下载、到期和失败重试都作为可追踪对象保存。', endpoint: '/reports/jobs', primary: '创建报表任务' },
}

function text(value: unknown, fallback: string | number = '—') { return value === null || value === undefined || value === '' ? String(fallback) : String(value) }
function number(value: unknown) { return typeof value === 'number' ? value : Number(value ?? 0) }
function navigate(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }
function tag(value: string) { const danger = /失败|差异|风险|滞留|未配置|需要动作/.test(value); const warn = /待|处理中|运行中|复核|运输/.test(value); return <span className={`fba-status ${danger ? 'danger' : warn ? 'warn' : 'ok'}`}><i />{value}</span> }

function sourceBadge(server: boolean) { return <span className={`fba-source ${server ? 'server' : 'unavailable'}`}><i />{server ? '服务端数据' : '未连接数据服务'}</span> }

function columns(module: FbaModule): Array<[string, string]> {
  if (module === 'orders') return [['orderId', 'Amazon Order ID'], ['purchaseDate', '下单时间'], ['store', '店铺'], ['items', '订单行 / 数量'], ['amount', '金额'], ['fulfillment', 'FBA 履约'], ['carrier', '承运商'], ['tracking', '追踪号'], ['promise', '配送承诺'], ['status', '订单状态']]
  if (module === 'products') return [['asin', 'ASIN'], ['sellerSku', 'Seller SKU'], ['fnsku', 'FNSKU'], ['title', '商品标题'], ['sizeTier', '尺寸段'], ['package', '包装 / 重量'], ['listingStatus', '刊登'], ['compliance', '合规'], ['updated', '更新时间']]
  if (module === 'inventory') return [['asin', 'ASIN'], ['sellerSku', 'Seller SKU'], ['fulfillable', 'Sellable'], ['reserved', 'Reserved'], ['inbound', 'Inbound'], ['unfulfillable', 'Unfulfillable'], ['days', 'Days of Supply'], ['age', '库龄'], ['stranded', '滞留原因'], ['health', '健康状态'], ['action', '建议动作']]
  if (module === 'inbound' || module === 'warehouse') return module === 'warehouse' ? [['fc', '履约中心'], ['address', '地址'], ['region', '区域'], ['units', '库存件数'], ['capacity', '容量使用'], ['receiving', '接收中'], ['discrepancies', '差异'], ['status', '状态'], ['nextShipment', '关联货件']] : [['shipment', 'Shipment ID'], ['plan', 'Inbound Plan'], ['asin', 'ASIN'], ['destination', '目的 FC'], ['placement', 'Placement'], ['transport', '运输方式'], ['tracking', 'Tracking'], ['expected', '应发'], ['received', '已收'], ['discrepancy', '差异'], ['stage', '阶段'], ['status', '状态']]
  if (module === 'fees') return [['type', '费用事件'], ['label', '业务口径'], ['amount', '金额'], ['object', '来源对象'], ['settlement', 'Settlement'], ['rule', '计算口径'], ['posted', '入账日'], ['status', '对账状态']]
  if (module === 'returns') return [['order', 'Amazon Order ID'], ['asin', 'ASIN'], ['sku', 'Seller SKU'], ['reason', '退货原因'], ['disposition', 'Disposition'], ['refund', '退款金额'], ['reimbursement', '赔付状态'], ['returned', '退货日'], ['status', '处理状态']]
  if (module === 'sync') return [['id', '任务编号'], ['domain', '数据域'], ['content', '同步内容'], ['site', '站点'], ['progress', '进度'], ['status', '状态'], ['started', '开始时间'], ['requestId', 'Request ID'], ['attempt', '尝试次数'], ['error', '失败原因']]
  if (module === 'connections') return [['provider', '连接类型'], ['account', '账号 / Endpoint'], ['scope', '授权范围'], ['state', '连接状态'], ['checked', '最近检查'], ['next', '下一步']]
  if (module === 'reports') return [['id', '任务编号'], ['reportType', 'Report Type'], ['scope', '业务范围'], ['status', '任务状态'], ['requestedBy', '发起人'], ['created', '创建时间'], ['expires', '下载截止'], ['requestId', 'Request ID']]
  return [['id', '工作项'], ['object', '业务对象'], ['area', '业务域'], ['detail', '待处理内容'], ['owner', '负责人'], ['due', '截止时间'], ['priority', '优先级'], ['status', '状态']]
}

function localRows(_module: FbaModule) { return [] as Row[] }

function OperationModal({ kind, onClose, onDone, connectionId }: { kind: 'sync' | 'inbound' | 'report'; onClose: () => void; onDone: (row: Row) => void; connectionId?: string }) {
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ domain: 'INVENTORY', name: '', source: '', asin: '', sku: '', quantity: '', reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' })
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      if (!isServerMode) throw new Error('ERP 服务端 API 未配置，生产环境不允许执行本地演示操作')
      if (kind === 'sync') {
        if (!connectionId) throw new Error('当前企业没有可用的 Amazon SP-API 连接')
        const result = await apiFetch<Row>('/fba/sync/jobs', { method: 'POST', body: JSON.stringify({ type: form.domain, connectionId, marketplaceId: 'ATVPDKIKX0DER' }) })
        onDone({ ...result, id: result.id, domain: form.domain, site: 'Amazon.com', progress: '0%', status: result.status ?? 'PENDING', requestId: result.requestId })
      } else if (kind === 'inbound') {
        const result = await apiFetch<Row>('/fba/inbound-plans', { method: 'POST', body: JSON.stringify({ name: form.name, marketplaceId: 'ATVPDKIKX0DER', sourceAddress: form.source, items: [{ asin: form.asin, sellerSku: form.sku, quantity: Number(form.quantity), prepOwner: 'SELLER', labelOwner: 'SELLER' }] }) })
        const plan = (result.plan ?? result) as Row
        onDone({ ...plan, id: plan.id, plan: plan.name, status: plan.status, stage: 'Create inbound plan' })
      } else {
        if (!connectionId) throw new Error('当前企业没有可用的 Amazon SP-API 连接')
        const result = await apiFetch<Row>('/reports/jobs', { method: 'POST', body: JSON.stringify({ reportType: form.reportType, marketplaceId: 'ATVPDKIKX0DER' }) })
        const report = (result.report ?? result) as Row
        onDone({ ...report, id: report.id, reportType: report.reportType, scope: 'Amazon.com · FBA', status: report.status, requestId: report.requestId })
      }
      Message.success('操作已提交，任务进入队列'); onClose()
    } catch (error) { Message.error(error instanceof Error ? error.message : '操作提交失败') } finally { setBusy(false) }
  }
  const title = kind === 'sync' ? '创建数据同步任务' : kind === 'inbound' ? '创建 FBA 入仓计划' : '创建 Amazon 报表任务'
  return <div className="fba-modal-backdrop" onClick={onClose}><form className="fba-modal" onClick={event => event.stopPropagation()} onSubmit={submit}><div className="fba-modal-head"><div><span className="fba-eyebrow">ACTION WORKFLOW</span><h2>{title}</h2><p>提交后会生成任务记录；Worker 将在服务端调用 Amazon 官方接口。</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div>{kind === 'sync' && <label>数据域<select value={form.domain} onChange={event => setForm({ ...form, domain: event.target.value })}>{['CATALOG', 'LISTINGS', 'ORDERS', 'INVENTORY', 'INBOUND', 'FINANCES', 'REPORTS', 'RETURNS', 'ADS'].map(item => <option key={item}>{item}</option>)}</select></label>}{kind === 'inbound' && <div className="fba-form-grid"><label>计划名称<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：2026-10 美国站补货" required /></label><label>发货地址<input value={form.source} onChange={event => setForm({ ...form, source: event.target.value })} placeholder="完整发货地址" required /></label><label>ASIN<input value={form.asin} onChange={event => setForm({ ...form, asin: event.target.value })} placeholder="Amazon ASIN" required /></label><label>Seller SKU<input value={form.sku} onChange={event => setForm({ ...form, sku: event.target.value })} placeholder="Seller SKU" required /></label><label>数量<input type="number" min="1" value={form.quantity} onChange={event => setForm({ ...form, quantity: event.target.value })} placeholder="数量" required /></label></div>}{kind === 'report' && <label>Report Type<select value={form.reportType} onChange={event => setForm({ ...form, reportType: event.target.value })}><option>GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA</option><option>GET_FBA_STORAGE_FEE_CHARGES_DATA</option><option>GET_MERCHANT_LISTINGS_ALL_DATA</option><option>GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA</option></select></label>}<div className="fba-modal-foot"><span className="fba-modal-note">服务端模式：需要已授权连接和对应写入权限。</span><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="blue-button" disabled={busy}>{busy ? '提交中…' : '确认提交'}</button></div></form></div>
}

export function FbaOperationsPage({ module }: { module: FbaModule }) {
  const meta = META[module]
  const [rows, setRows] = useState<Row[]>(() => localRows(module))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('全部状态')
  const [selected, setSelected] = useState<Row | null>(null)
  const [modal, setModal] = useState<'sync' | 'inbound' | 'report' | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [summary, setSummary] = useState<Row | null>(null)
  const [connectionId, setConnectionId] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true); setError('')
      if (!isServerMode) { setRows([]); setSummary(null); setError('ERP 服务端 API 未配置，生产环境不会显示演示数据'); setLoading(false); return }
      try {
        if (module === 'overview') {
          const result = await apiFetch<Row>('/fba/summary?marketplaceId=ATVPDKIKX0DER')
          const inventory = (result.inventory ?? {}) as Row
          const sums = (inventory._sum ?? {}) as Row
          if (alive) setSummary({
            fulfillable: sums.fulfillableQuantity,
            reserved: sums.reservedQuantity,
            inbound: number(sums.inboundWorkingQuantity) + number(sums.inboundShippedQuantity) + number(sums.inboundReceivingQuantity),
            openInbound: result.openInboundPlans,
            openReturns: result.openReturns,
            feeTotal: result.feeTotal,
          })
        } else if (meta.endpoint) {
          const queryText = new URLSearchParams({ marketplaceId: 'ATVPDKIKX0DER', page: '1', pageSize: '50', ...(query ? { q: query } : {}), ...(status !== '全部状态' ? { status } : {}) }).toString()
          const result = await apiFetch<unknown>(`${meta.endpoint}${meta.endpoint.includes('?') ? '&' : '?'}${queryText}`)
          const payload = result as { items?: Row[] } | Row[]
          if (alive) setRows(Array.isArray(payload) ? payload : payload.items ?? [])
        }
        if (module === 'sync' || module === 'connections' || module === 'reports') {
          const result = await apiFetch<unknown>(module === 'sync' ? '/sync/jobs' : module === 'connections' ? '/connections' : '/reports/jobs?marketplaceId=ATVPDKIKX0DER&page=1&pageSize=50')
          const payload = result as { items?: Row[] } | Row[]; if (alive) setRows(Array.isArray(payload) ? payload : payload.items ?? [])
        }
        try { const connections = await apiFetch<Row[]>('/connections'); if (alive) setConnectionId(text(connections[0]?.id, '') || undefined) } catch { if (alive) setConnectionId(undefined) }
      } catch (reason) { if (alive) { setError(reason instanceof Error ? reason.message : '数据加载失败'); setRows([]) } } finally { if (alive) setLoading(false) }
    }
    void load(); return () => { alive = false }
  }, [module, refreshKey, query, status, meta.endpoint])

  const filteredRows = useMemo(() => rows.filter(row => { const haystack = Object.values(row).map(value => text(value)).join(' ').toLowerCase(); return haystack.includes(query.toLowerCase()) && (status === '全部状态' || text(row.status) === status || text(row.health) === status) }), [rows, query, status])
  const source = isServerMode && !error
  const addRow = (row: Row) => setRows(current => [row, ...current])
  const startAmazonAuthorization = async () => { if (!isServerMode) { Message.error('服务端 API 未配置，无法发起 Amazon 授权') ; return } try { const entities = await apiFetch<Row[]>('/entities'); const entityId = text(entities[0]?.id, ''); if (!entityId) throw new Error('请先配置法律主体'); const result = await apiFetch<{ authorizationUrl: string }>('/sp-api/oauth/start', { method: 'POST', body: JSON.stringify({ legalEntityId: entityId, region: 'NA', returnUrl: `${window.location.origin}/api/v1/sp-api/oauth/callback` }) }); window.location.href = result.authorizationUrl } catch (reason) { Message.error(reason instanceof Error ? reason.message : '无法发起 Amazon 授权') } }
  const retry = async (row: Row) => { try { if (!isServerMode) throw new Error('服务端 API 未配置，无法重试任务'); await apiFetch(`/sync/jobs/${text(row.id)}/retry`, { method: 'POST' }); Message.success('已提交重试任务'); setRefreshKey(value => value + 1) } catch (reason) { Message.error(reason instanceof Error ? reason.message : '重试失败') } }
  const openPrimary = () => { if (module === 'overview' || module === 'sync') setModal('sync'); else if (module === 'inbound' || module === 'warehouse' || module === 'inventory') setModal('inbound'); else if (module === 'reports' || module === 'fees' || module === 'returns') setModal('report'); else if (module === 'connections') void startAmazonAuthorization(); else setModal('sync') }
  const displayValue = (key: string, value: unknown) => { if (key === 'amount' || key === 'refund' || key === 'price') return `${number(value) >= 0 ? '$' : '-$'}${Math.abs(number(value)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`; if (key === 'status' || key === 'health' || key === 'state' || key === 'reimbursement' || key === 'listingStatus' || key === 'compliance') return tag(text(value)); if (key === 'progress') return <div className="fba-progress"><i style={{ width: text(value) }} /><small>{text(value)}</small></div>; return text(value) }

  return <div className="page-body fba-ops-page">
    <div className="fba-ops-header"><div><div className="fba-breadcrumb">企业工作区 <span>/</span> Amazon.com <span>/</span> {meta.title}</div><span className="fba-eyebrow">{meta.kicker}</span><h1>{meta.title}</h1><p>{meta.subtitle}</p></div><div className="fba-header-actions">{sourceBadge(source)}<button className="outline-button" onClick={() => setRefreshKey(value => value + 1)}>↻ 刷新</button><button className="blue-button" onClick={openPrimary}>＋ {meta.primary}</button></div></div>
    <div className="fba-context-strip"><div><small>Marketplace</small><b>Amazon.com · ATVPDKIKX0DER</b></div><div><small>履约渠道</small><b>FBA · Amazon Fulfillment</b></div><div><small>数据口径</small><b>USD · US Eastern Time</b></div><div><small>当前权限</small><b><i className="status-dot" />由服务端权限返回</b></div><div><small>更新时间</small><b>{source ? '由服务端返回' : '服务端未配置'}</b></div></div>
    {module === 'overview' && <div className="fba-kpi-grid"><div><small>Sellable / Reserved / Inbound</small><b>{text(summary?.fulfillable)} / {text(summary?.reserved)} / {text(summary?.inbound)}</b><span>来自 FBA inventory 汇总</span></div><div><small>待处理工作项</small><b>—</b><span>由任务与异常服务返回</span></div><div><small>开放 Inbound Plan</small><b>{text(summary?.openInbound)}</b><span>Shipment / Receiving</span></div><div><small>待退货与赔付</small><b>{text(summary?.openReturns)}</b><span>需要关联证据</span></div><div><small>FBA 费用事件</small><b>{summary?.feeTotal === undefined ? '—' : `$${number(summary.feeTotal).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</b><span>当前结算周期</span></div></div>}
    {error && <div className="fba-error"><b>数据加载失败</b><span>{error}</span><button className="link-button" onClick={() => setRefreshKey(value => value + 1)}>重试</button></div>}
    {module === 'overview' ? <div className="fba-overview-grid"><section className="table-panel"><div className="table-head"><div><h3>运营工作队列</h3><span className="table-subtitle">业务对象和任务由服务端返回</span></div><span className="fba-count">{filteredRows.length} 个对象</span></div><div className="table-scroll"><table className="data-table fba-object-table"><thead><tr>{columns('overview').map(([, label]) => <th key={label}>{label}</th>)}<th>操作</th></tr></thead><tbody>{filteredRows.map(row => <tr key={text(row.id)} onClick={() => setSelected(row)}>{columns('overview').map(([key]) => <td key={key}>{displayValue(key, row[key])}</td>)}<td><button className="link-button" onClick={() => setSelected(row)}>打开对象</button></td></tr>)}</tbody></table></div>{!loading && !filteredRows.length && <div className="fba-empty"><b>暂无真实工作项</b><span>{error ? '先处理服务端连接问题。' : '完成 Amazon 授权并执行同步后，真实任务会在此出现。'}</span></div>}</section><aside className="fba-side-stack"><section className="panel"><div className="panel-head"><div><h3>执行入口</h3><span>每个动作都会进入服务端任务队列</span></div></div><button className="fba-action-row" onClick={() => setModal('inbound')}><span>＋</span><div><b>创建补货 / Inbound Plan</b><small>需要 Amazon US SP-API 连接和写入权限</small></div><i>→</i></button><button className="fba-action-row" onClick={() => setModal('sync')}><span>↻</span><div><b>同步 Amazon FBA 数据</b><small>按官方数据域创建服务端任务</small></div><i>→</i></button><button className="fba-action-row" onClick={() => setModal('report')}><span>▤</span><div><b>生成 FBA 报表</b><small>任务完成后才允许签发下载地址</small></div><i>→</i></button></section><section className="panel"><div className="panel-head"><div><h3>数据边界</h3><span>生产环境执行规则</span></div></div><dl className="fba-definition"><div><dt>对象来源</dt><dd>Amazon SP-API / Reports</dd></div><div><dt>写入动作</dt><dd>权限校验 → Queue → Audit</dd></div><div><dt>凭据</dt><dd>服务端加密存储，前端不可见</dd></div></dl></section></aside></div> : <><div className="fba-list-toolbar"><div className="fba-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 ASIN、SKU、Shipment、任务编号或业务对象" /></div><select value={status} onChange={event => setStatus(event.target.value)}><option>全部状态</option><option>正常</option><option>ACTIVE</option><option>已完成</option><option>运行中</option><option>失败</option><option>待核对</option><option>差异</option><option>低库存</option><option>授权待确认</option><option>未配置</option></select><span className="fba-result">匹配 {filteredRows.length} / {rows.length} 条记录</span><button className="outline-button" onClick={() => Message.info('列配置会保存到当前成员偏好')}>列配置</button></div><div className="table-panel"><div className="table-head"><div><h3>{meta.title} · 对象列表</h3><span className="table-subtitle">所有行来自当前租户服务端查询</span></div><div className="fba-table-meta">{loading ? '正在读取…' : source ? '服务端查询完成' : '服务端未配置'} · {filteredRows.length} rows</div></div>{loading ? <div className="fba-empty">正在加载 {meta.title} 数据…</div> : !filteredRows.length ? <div className="fba-empty"><b>暂无真实记录</b><span>{error ? '请先修复服务端连接或权限。' : '完成对应数据域同步后，真实对象会显示在这里。'}</span></div> : <div className="table-scroll"><table className="data-table fba-object-table"><thead><tr>{columns(module).map(([, label]) => <th key={label}>{label}</th>)}<th>动作</th></tr></thead><tbody>{filteredRows.map(row => <tr key={text(row.id)} onClick={() => setSelected(row)}>{columns(module).map(([key]) => <td key={key}>{displayValue(key, row[key])}</td>)}<td onClick={event => event.stopPropagation()}><button className="link-button" onClick={() => setSelected(row)}>{module === 'sync' && text(row.status) === 'FAILED' ? '查看并重试' : '查看详情'}</button></td></tr>)}</tbody></table></div>}</div></>}
    {selected && <div className="fba-drawer-backdrop" onClick={() => setSelected(null)}><aside className="fba-detail-drawer" onClick={event => event.stopPropagation()}><div className="fba-drawer-head"><div><span className="fba-eyebrow">OBJECT DETAIL</span><h2>{text(selected.id)}</h2><small>{meta.title} · Amazon.com · 服务端记录</small></div><button className="close-button" onClick={() => setSelected(null)}>×</button></div><div className="fba-drawer-status">{tag(text(selected.status ?? selected.health ?? selected.state ?? '待处理'))}<span>最近更新：{text(selected.updatedAt ?? selected.checked ?? selected.startedAt ?? selected.returnDate)}</span></div><div className="fba-detail-grid">{Object.entries(selected).filter(([key]) => key !== 'id').slice(0, 16).map(([key, value]) => <div key={key}><small>{key}</small><b>{typeof value === 'object' ? JSON.stringify(value) : text(value)}</b></div>)}</div>{module === 'sync' && text(selected.status) === 'FAILED' && <div className="fba-drawer-alert"><b>失败原因</b><span>{text(selected.failureCode)}</span><button className="blue-button" onClick={() => retry(selected)}>重试该任务</button></div>}{(module === 'inventory' || module === 'products') && <button className="blue-button fba-drawer-action" onClick={() => { setSelected(null); setModal('inbound') }}>从该对象创建补货计划</button>}{module === 'connections' && <button className="outline-button fba-drawer-action" onClick={() => navigate('/app/sync')}>查看连接同步任务</button>}</aside></div>}
    {modal && <OperationModal kind={modal} connectionId={connectionId} onClose={() => setModal(null)} onDone={addRow} />}
  </div>
}
