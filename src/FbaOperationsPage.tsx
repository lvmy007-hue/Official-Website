import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Message } from '@arco-design/web-react'
import { apiFetch, isServerMode } from './api'
import './fba-operations.css'

export type FbaModule = 'overview' | 'orders' | 'products' | 'inventory' | 'inbound' | 'warehouse' | 'fees' | 'returns' | 'sync' | 'connections' | 'reports' | 'settlements'
type Row = Record<string, unknown>

type ModuleMeta = { title: string; kicker: string; subtitle: string; endpoint?: string; primary?: string }

const META: Record<FbaModule, ModuleMeta> = {
  overview: { title: 'FBA 运营控制台', kicker: 'AMAZON.COM · FBA OPERATIONS', subtitle: '以待办、状态和可执行对象组织每日运营，不用图表代替业务动作。', primary: '创建同步任务' },
  orders: { title: 'FBA 订单', kicker: 'ORDERS · FBA FULFILLMENT', subtitle: '订单头、订单行、履约中心、配送承诺、承运商和退货关联进入同一条记录链。', endpoint: '/orders', primary: '同步订单' },
  products: { title: 'ASIN / SKU 主数据', kicker: 'CATALOG · LISTINGS · COMPLIANCE', subtitle: 'ASIN、Seller SKU、FNSKU、尺寸段、刊登状态和履约标识的统一对象台。', endpoint: '/fba/products', primary: '同步商品目录' },
  inventory: { title: 'FBA 库存健康', kicker: 'FBA INVENTORY · HEALTH', subtitle: 'Sellable、Reserved、Inbound、Unfulfillable、库龄和 Days of Supply 进入同一张可处理清单。', endpoint: '/fba/inventory', primary: '创建补货计划' },
  inbound: { title: '采购与 FBA 入库', kicker: 'SUPPLY CHAIN · INBOUND', subtitle: '从补货建议到 Inbound Plan、Shipment、运输、标签、FC 接收和差异核对的执行台。', endpoint: '/fba/inbound-plans', primary: '创建入仓计划' },
  warehouse: { title: 'FBA 货件与仓库', kicker: 'FULFILLMENT CENTER · RECEIVING', subtitle: '按 Fulfillment Center 管理货件接收、追踪、数量差异和后续赔付证据。', endpoint: '/fba/inbound-plans', primary: '创建 FBA 货件' },
  fees: { title: 'FBA 费用事件', kicker: 'FINANCES · FEE EVENTS', subtitle: '把履约费、仓储费、入仓配置费、库龄费、移除/弃置和赔付拆成可对账事件。', endpoint: '/fba/fees', primary: '生成费用报表' },
  settlements: { title: 'FBA 结算交易', kicker: 'FINANCES · SETTLEMENT TRANSACTIONS', subtitle: '按结算周期、交易类型和订单关联核对 Amazon 入账，支持财务追溯。', endpoint: '/fba/settlements', primary: '生成结算报表' },
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
  if (module === 'settlements') return [['settlement', 'Settlement ID'], ['period', '结算周期'], ['deposit', '打款日期'], ['total', '结算金额'], ['currency', '币种'], ['status', '状态'], ['transactions', '交易明细'], ['store', '卖家账号']]
  if (module === 'returns') return [['order', 'Amazon Order ID'], ['asin', 'ASIN'], ['sku', 'Seller SKU'], ['reason', '退货原因'], ['disposition', 'Disposition'], ['refund', '退款金额'], ['reimbursement', '赔付状态'], ['returned', '退货日'], ['status', '处理状态']]
  if (module === 'sync') return [['id', '任务编号'], ['domain', '数据域'], ['content', '同步内容'], ['site', '站点'], ['progress', '进度'], ['status', '状态'], ['started', '开始时间'], ['requestId', 'Request ID'], ['attempt', '尝试次数'], ['error', '失败原因']]
  if (module === 'connections') return [['provider', '连接类型'], ['account', '账号 / Endpoint'], ['scope', '授权范围'], ['state', '连接状态'], ['checked', '最近检查'], ['next', '下一步']]
  if (module === 'reports') return [['id', '任务编号'], ['reportType', 'Report Type'], ['scope', '业务范围'], ['status', '任务状态'], ['requestedBy', '发起人'], ['created', '创建时间'], ['expires', '下载截止'], ['requestId', 'Request ID']]
  return [['id', '工作项'], ['object', '业务对象'], ['area', '业务域'], ['detail', '待处理内容'], ['owner', '负责人'], ['due', '截止时间'], ['priority', '优先级'], ['status', '状态']]
}

function asRows(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as Row).items)) return (payload as Row).items as Row[]
  return []
}
function iso(value: unknown) { return value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : '—' }
function nested(row: Row, key: string) { return row[key] && typeof row[key] === 'object' ? row[key] as Row : {} }
function normalizeRow(module: FbaModule, row: Row): Row {
  const seller = nested(row, 'sellerAccount')
  if (module === 'overview') return { ...row, id: row.id, object: row.dataDomain ?? row.type ?? '同步任务', area: row.apiDomain ?? 'Amazon SP-API', detail: row.failureCode ?? (row.status === 'SUCCEEDED' ? '任务已完成' : '等待 Worker 执行'), owner: '系统调度', due: iso(row.finishedAt ?? row.createdAt), priority: row.status === 'FAILED' || row.status === 'FAILED_PERMANENT' ? '高' : '标准', status: row.status }
  if (module === 'orders') return { ...row, id: row.id ?? row.amazonOrderId, orderId: row.amazonOrderId, purchaseDate: iso(row.purchaseDate), store: seller.displayName ?? seller.sellerId, items: row.itemCount ?? '—', amount: row.amount, fulfillment: row.fulfillment === 'AFN' ? 'FBA' : row.fulfillment, carrier: '—', tracking: '—', promise: '—', status: row.status, updated: iso(row.sourceUpdatedAt) }
  if (module === 'products') return { ...row, id: row.id ?? row.sellerSku, asin: row.asin, sellerSku: row.sellerSku, fnsku: row.fnsku, title: row.title, sizeTier: row.sizeTier, package: [row.packageLengthCm, row.packageWidthCm, row.packageHeightCm].filter(Boolean).join(' × ') || (row.packageWeightKg ? `${row.packageWeightKg} kg` : '—'), listingStatus: row.listingStatus, compliance: row.fulfillmentChannel === 'AFN' ? 'FBA' : row.fulfillmentChannel, updated: iso(row.sourceUpdatedAt ?? row.updatedAt) }
  if (module === 'inventory') return { ...row, id: row.id ?? row.sellerSku, asin: row.asin, sellerSku: row.sellerSku, fulfillable: row.fulfillableQuantity, reserved: row.reservedQuantity, inbound: Number(row.inboundWorkingQuantity ?? 0) + Number(row.inboundShippedQuantity ?? 0) + Number(row.inboundReceivingQuantity ?? 0), unfulfillable: row.unfulfillableQuantity, days: row.daysOfSupply, age: row.inventoryAgeDays, stranded: row.strandedReason, health: row.healthStatus, action: row.healthStatus === 'LOW_STOCK' ? '创建补货计划' : '持续观察' }
  if (module === 'inbound' || module === 'warehouse') {
    const shipments = Array.isArray(row.shipments) ? row.shipments as Row[] : []
    const shipment = shipments[0] ?? {}
    const item = Array.isArray(row.items) ? (row.items as unknown[])[0] as Row | undefined : undefined
    if (module === 'warehouse') return { ...row, id: shipment.id ?? row.id, fc: shipment.destinationFc, address: row.sourceAddress, region: 'US', units: shipment.unitsExpected ?? row.totalUnits, capacity: '—', receiving: shipment.unitsReceived, discrepancies: shipment.discrepancyQuantity, status: shipment.status ?? row.status, nextShipment: shipment.shipmentId }
    return { ...row, id: shipment.id ?? row.id, shipment: shipment.shipmentId, plan: row.externalPlanId ?? row.name, asin: item?.asin, destination: shipment.destinationFc, placement: shipment.placementOption ?? row.placementOption, transport: shipment.transportStatus, tracking: shipment.trackingNumber, expected: shipment.unitsExpected ?? row.totalUnits, received: shipment.unitsReceived, discrepancy: shipment.discrepancyQuantity, stage: row.status, status: shipment.status ?? row.status }
  }
  if (module === 'fees') return { ...row, id: row.id, type: row.eventType, label: row.description ?? row.eventType, amount: row.amount, object: row.amazonOrderId ?? row.asin ?? row.sellerSku, settlement: row.settlementId, rule: row.description, posted: iso(row.postedAt), status: row.eventType }
  if (module === 'settlements') return { ...row, id: row.id, settlement: row.externalSettlementId, period: iso(row.settlementStartDate) + ' → ' + iso(row.settlementEndDate), deposit: iso(row.depositDate), total: row.totalAmount, currency: row.currency, status: row.status, transactions: Array.isArray(row.transactions) ? row.transactions.length : 0, store: seller.displayName ?? seller.sellerId }
  if (module === 'returns') return { ...row, id: row.id ?? row.returnId ?? row.amazonOrderId, order: row.amazonOrderId, asin: row.asin, sku: row.sellerSku, reason: row.reason, disposition: row.disposition, refund: row.refundAmount, reimbursement: row.reimbursementStatus, returned: iso(row.returnDate), status: row.status }
  if (module === 'sync') return { ...row, id: row.id, domain: String(row.type ?? '').replace(/^FBA_/, ''), content: row.failureCode ?? (row.type === 'FBA_ORDERS' ? 'Orders API' : row.type === 'FBA_INVENTORY' ? 'FBA Inventory API' : row.type === 'FBA_FINANCE' ? 'Finances API' : row.type), site: 'Amazon.com', progress: row.progressTotal ? `${Math.round((Number(row.progressCurrent ?? 0) / Number(row.progressTotal)) * 100)}%` : row.status === 'SUCCEEDED' ? '100%' : '0%', status: row.status, started: iso(row.startedAt ?? row.createdAt), requestId: row.requestId, attempt: row.attempts, error: row.failureCode }
  if (module === 'connections') {
    const health = Array.isArray(row.healthChecks) ? (row.healthChecks as Row[])[0] ?? {} : {}
    return { ...row, id: row.id, provider: row.provider === 'AMAZON_ADS_API' ? 'Amazon Ads API' : 'Amazon SP-API', account: row.externalAccountId ?? seller.displayName ?? row.provider, scope: Array.isArray(row.grantedScopes) ? (row.grantedScopes as unknown[]).join(' · ') : row.grantedScopes, state: row.state, checked: iso(row.lastHealthCheckedAt ?? health.checkedAt), next: row.state === 'AUTHORIZED' ? '执行数据同步' : '完成授权' }
  }
  if (module === 'reports') return { ...row, id: row.id, reportType: row.reportType, scope: `${row.marketplaceId ?? 'Amazon.com'} · FBA`, status: row.status, requestedBy: nested(row, 'createdBy').displayName ?? '企业管理员', created: iso(row.createdAt), expires: iso(row.expiresAt), requestId: row.requestId, downloadUrl: row.downloadUrl, failureCode: row.failureCode }
  return row
}
function normalizeRows(module: FbaModule, rows: Row[]) { return rows.flatMap(row => (module === 'inbound' || module === 'warehouse') && Array.isArray(row.shipments) && row.shipments.length > 1 ? (row.shipments as Row[]).map(shipment => normalizeRow(module, { ...row, shipments: [shipment] })) : [normalizeRow(module, row)]) }
function localRows(_module: FbaModule) { return [] as Row[] }

function OperationModal({ kind, onClose, onDone, sellerConnectionId, adsConnectionId, defaultDomain, defaultReportType }: { kind: 'sync' | 'inbound' | 'report'; onClose: () => void; onDone: (row: Row) => void; sellerConnectionId?: string; adsConnectionId?: string; defaultDomain?: string; defaultReportType?: string }) {
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ domain: defaultDomain ?? 'INVENTORY', marketplaceId: 'ATVPDKIKX0DER', name: '', addressName: '', addressLine1: '', city: '', stateOrProvinceCode: '', countryCode: 'US', postalCode: '', phoneNumber: '', asin: '', sku: '', quantity: '', reportType: defaultReportType ?? 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' })
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      if (!isServerMode) throw new Error('ERP 服务端 API 未配置，生产环境不允许执行本地演示操作')
      if (kind === 'sync') {
        const connectionId = form.domain === 'ADS' ? adsConnectionId : sellerConnectionId
        if (!connectionId) throw new Error(form.domain === 'ADS' ? '当前企业没有已授权的 Amazon Ads 连接' : '当前企业没有已授权的 Amazon SP-API 连接')
        const result = await apiFetch<Row>('/fba/sync/jobs', { method: 'POST', body: JSON.stringify({ type: form.domain, connectionId, marketplaceId: 'ATVPDKIKX0DER' }) })
        onDone({ ...result, id: result.id, domain: form.domain, site: 'Amazon.com', progress: '0%', status: result.status ?? 'PENDING', requestId: result.requestId })
      } else if (kind === 'inbound') {
        const result = await apiFetch<Row>('/fba/inbound-plans', { method: 'POST', body: JSON.stringify({ name: form.name, marketplaceId: form.marketplaceId, sourceAddress: { name: form.addressName, addressLine1: form.addressLine1, city: form.city, stateOrProvinceCode: form.stateOrProvinceCode, countryCode: form.countryCode, postalCode: form.postalCode, phoneNumber: form.phoneNumber }, items: [{ asin: form.asin, sellerSku: form.sku, quantity: Number(form.quantity), prepOwner: 'SELLER', labelOwner: 'SELLER' }] }) })
        const plan = (result.plan ?? result) as Row
        onDone({ ...plan, id: plan.id, plan: plan.name, status: plan.status, stage: 'Create inbound plan' })
      } else {
        if (!sellerConnectionId) throw new Error('当前企业没有已授权的 Amazon SP-API 连接')
        const result = await apiFetch<Row>('/reports/jobs', { method: 'POST', body: JSON.stringify({ reportType: form.reportType, marketplaceId: 'ATVPDKIKX0DER' }) })
        const report = (result.report ?? result) as Row
        onDone({ ...report, id: report.id, reportType: report.reportType, scope: 'Amazon.com · FBA', status: report.status, requestId: report.requestId })
      }
      Message.success('操作已提交，任务进入队列'); onClose()
    } catch (error) { Message.error(error instanceof Error ? error.message : '操作提交失败') } finally { setBusy(false) }
  }
  const title = kind === 'sync' ? '创建数据同步任务' : kind === 'inbound' ? '创建 FBA 入仓计划' : '创建 Amazon 报表任务'
  return <div className="fba-modal-backdrop" onClick={onClose}><form className={kind === 'inbound' ? 'fba-modal fba-modal-wide' : 'fba-modal'} onClick={event => event.stopPropagation()} onSubmit={submit}><div className="fba-modal-head"><div><span className="fba-eyebrow">ACTION WORKFLOW</span><h2>{title}</h2><p>提交后会生成任务记录；Worker 将在服务端调用 Amazon 官方接口。</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div>{kind === 'sync' && <label>数据域<select value={form.domain} onChange={event => setForm({ ...form, domain: event.target.value })}>{['ORDERS', 'INVENTORY', 'FINANCES', 'ADS'].map(item => <option key={item}>{item}</option>)}</select></label>}{kind === 'inbound' && <div className="fba-form-grid"><label>计划名称<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：2026-10 美国站补货" required /></label><label>站点<select value={form.marketplaceId} onChange={event => setForm({ ...form, marketplaceId: event.target.value })}><option value="ATVPDKIKX0DER">Amazon.com 美国</option><option value="A2EUQ1WTGCTBG2">Amazon.ca 加拿大</option><option value="A1AM78C64UM0Y8">Amazon.com.mx 墨西哥</option><option value="A2Q3Y263D00KWC">Amazon.com.br 巴西</option></select></label><label>发货人<input value={form.addressName} onChange={event => setForm({ ...form, addressName: event.target.value })} required /></label><label>街道地址<input value={form.addressLine1} onChange={event => setForm({ ...form, addressLine1: event.target.value })} required /></label><label>城市<input value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} required /></label><label>州 / 省<input value={form.stateOrProvinceCode} onChange={event => setForm({ ...form, stateOrProvinceCode: event.target.value })} placeholder="CA" required /></label><label>国家<input value={form.countryCode} onChange={event => setForm({ ...form, countryCode: event.target.value })} placeholder="US" maxLength={2} required /></label><label>邮编<input value={form.postalCode} onChange={event => setForm({ ...form, postalCode: event.target.value })} required /></label><label>电话<input value={form.phoneNumber} onChange={event => setForm({ ...form, phoneNumber: event.target.value })} required /></label><label>ASIN<input value={form.asin} onChange={event => setForm({ ...form, asin: event.target.value })} placeholder="Amazon ASIN" required /></label><label>Seller SKU<input value={form.sku} onChange={event => setForm({ ...form, sku: event.target.value })} placeholder="Seller SKU" required /></label><label>数量<input type="number" min="1" value={form.quantity} onChange={event => setForm({ ...form, quantity: event.target.value })} placeholder="数量" required /></label></div>}{kind === 'report' && <label>Report Type<select value={form.reportType} onChange={event => setForm({ ...form, reportType: event.target.value })}><option>GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA</option><option>GET_FBA_STORAGE_FEE_CHARGES_DATA</option><option>GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2</option><option>GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE</option><option>GET_MERCHANT_LISTINGS_ALL_DATA</option><option>GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA</option></select></label>}<div className="fba-modal-foot"><span className="fba-modal-note">服务端模式：需要已授权连接和对应写入权限。</span><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="blue-button" disabled={busy}>{busy ? '提交中…' : '确认提交'}</button></div></form></div>
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
  const [sellerConnectionId, setSellerConnectionId] = useState<string | undefined>()
  const [adsConnectionId, setAdsConnectionId] = useState<string | undefined>()
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 50

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true); setError('')
      if (!isServerMode) { setRows([]); setSummary(null); setTotal(0); setError('ERP 服务端 API 未配置，生产环境不会显示演示数据'); setLoading(false); return }
      try {
        if (module === 'overview') {
          const [summaryResult, jobsResult] = await Promise.all([apiFetch<Row>('/fba/summary?marketplaceId=ATVPDKIKX0DER'), apiFetch<unknown>('/sync/jobs')])
          const inventory = (summaryResult.inventory ?? {}) as Row
          const sums = (inventory._sum ?? {}) as Row
          if (alive) {
            setSummary({ fulfillable: sums.fulfillableQuantity, reserved: sums.reservedQuantity, inbound: number(sums.inboundWorkingQuantity) + number(sums.inboundShippedQuantity) + number(sums.inboundReceivingQuantity), openInbound: summaryResult.openInboundPlans, openReturns: summaryResult.openReturns, feeTotal: summaryResult.feeTotal })
            const nextRows = normalizeRows('overview', asRows(jobsResult)); setRows(nextRows); setTotal(nextRows.length)
          }
        } else {
          const endpoint = module === 'sync' ? '/sync/jobs' : module === 'connections' ? '/connections' : module === 'reports' ? '/reports/jobs' : meta.endpoint
          if (!endpoint) return
          const queryText = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(query ? { q: query } : {}), ...(status !== '全部状态' ? { status } : {}) }).toString()
          const result = await apiFetch<unknown>(`${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryText}`)
          const payload = result as { items?: Row[]; total?: number } | Row[]
          const rawRows = asRows(payload)
          if (alive) { setRows(normalizeRows(module, rawRows)); setTotal(Array.isArray(payload) ? rawRows.length : Number(payload.total ?? rawRows.length)) }
        }
        try { const connections = await apiFetch<Row[]>('/connections'); if (alive) { setSellerConnectionId(text(connections.find(item => item.provider === 'AMAZON_SP_API' && item.state === 'AUTHORIZED')?.id, '') || undefined); setAdsConnectionId(text(connections.find(item => item.provider === 'AMAZON_ADS_API' && item.state === 'AUTHORIZED')?.id, '') || undefined) } } catch { if (alive) { setSellerConnectionId(undefined); setAdsConnectionId(undefined) } }
      } catch (reason) { if (alive) { setError(reason instanceof Error ? reason.message : '数据加载失败'); setRows([]); setTotal(0) } } finally { if (alive) setLoading(false) }
    }
    void load(); return () => { alive = false }
  }, [module, refreshKey, query, status, page, meta.endpoint])
  const filteredRows = useMemo(() => rows.filter(row => { const haystack = Object.values(row).map(value => text(value)).join(' ').toLowerCase(); const matchesQuery = haystack.includes(query.trim().toLowerCase()); const matchesStatus = status === '全部状态' || text(row.status) === status || text(row.health) === status || text(row.state) === status; return matchesQuery && matchesStatus }), [rows, query, status])
  const source = isServerMode && !error
  const addRow = (row: Row) => { setRows(current => [normalizeRow(module, row), ...current]); setTotal(current => current + 1) }
  const exportRows = () => { const fields = columns(module); const csv = [fields.map(([, label]) => label), ...filteredRows.map(row => fields.map(([key]) => text(row[key], '')))].map(line => line.map(cell => '"' + String(cell).replace('"', '""') + '"').join(',')).join('\r\n'); const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'nova-' + module + '-' + new Date().toISOString().slice(0, 10) + '.csv'; link.click(); URL.revokeObjectURL(url) }
  const startAmazonAuthorization = async () => { if (!isServerMode) { Message.error('服务端 API 未配置，无法发起 Amazon 授权') ; return } try { const entities = await apiFetch<Row[]>('/entities'); const entityId = text(entities[0]?.id, ''); if (!entityId) throw new Error('请先配置法律主体'); const result = await apiFetch<{ authorizationUrl: string }>('/sp-api/oauth/start', { method: 'POST', body: JSON.stringify({ legalEntityId: entityId, region: 'NA' }) }); window.location.href = result.authorizationUrl } catch (reason) { Message.error(reason instanceof Error ? reason.message : '无法发起 Amazon 授权') } }
  const startAdsAuthorization = async () => { if (!isServerMode) { Message.error('服务端 API 未配置，无法发起 Amazon Ads 授权'); return } try { const result = await apiFetch<{ authorizationUrl: string }>('/ads/oauth/start', { method: 'POST', body: '{}' }); window.location.href = result.authorizationUrl } catch (reason) { Message.error(reason instanceof Error ? reason.message : '无法发起 Amazon Ads 授权') } }
  const retry = async (row: Row) => { try { if (!isServerMode) throw new Error('服务端 API 未配置，无法重试任务'); await apiFetch(`/sync/jobs/${text(row.id)}/retry`, { method: 'POST' }); Message.success('已提交重试任务'); setRefreshKey(value => value + 1) } catch (reason) { Message.error(reason instanceof Error ? reason.message : '重试失败') } }
  const openPrimary = () => { if (module === 'connections') void startAmazonAuthorization(); else if (module === 'inbound' || module === 'warehouse' || module === 'inventory') setModal('inbound'); else if (module === 'products' || module === 'reports' || module === 'returns' || module === 'settlements') setModal('report'); else setModal('sync') }
  const defaultDomain = module === 'orders' ? 'ORDERS' : module === 'fees' || module === 'settlements' ? 'FINANCES' : 'INVENTORY'
  const defaultReportType = module === 'products' ? 'GET_MERCHANT_LISTINGS_ALL_DATA' : module === 'reports' ? 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' : module === 'settlements' ? 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2' : 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA'
  const displayValue = (key: string, value: unknown) => { if (key === 'amount' || key === 'refund' || key === 'price') return `${number(value) >= 0 ? '$' : '-$'}${Math.abs(number(value)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`; if (key === 'status' || key === 'health' || key === 'state' || key === 'reimbursement' || key === 'listingStatus' || key === 'compliance') return tag(text(value)); if (key === 'progress') return <div className="fba-progress"><i style={{ width: text(value) }} /><small>{text(value)}</small></div>; return text(value) }

  return <div className="page-body fba-ops-page">
    <div className="fba-ops-header"><div><div className="fba-breadcrumb">企业工作区 <span>/</span> Amazon.com <span>/</span> {meta.title}</div><span className="fba-eyebrow">{meta.kicker}</span><h1>{meta.title}</h1><p>{meta.subtitle}</p></div><div className="fba-header-actions">{sourceBadge(source)}<button className="outline-button" onClick={() => setRefreshKey(value => value + 1)}>↻ 刷新</button>{module === 'connections' ? <><button className="outline-button" onClick={() => void startAmazonAuthorization()}>授权卖家</button><button className="blue-button" onClick={() => void startAdsAuthorization()}>授权广告</button></> : <button className="blue-button" onClick={openPrimary}>＋ {meta.primary}</button>}</div></div>
    <div className="fba-context-strip"><div><small>Marketplace</small><b>已授权站点</b></div><div><small>履约渠道</small><b>FBA · Amazon Fulfillment</b></div><div><small>数据口径</small><b>USD · US Eastern Time</b></div><div><small>当前权限</small><b><i className="status-dot" />由服务端权限返回</b></div><div><small>更新时间</small><b>{source ? '由服务端返回' : '服务端未配置'}</b></div></div>
    {module === 'overview' && <div className="fba-kpi-grid"><div><small>Sellable / Reserved / Inbound</small><b>{text(summary?.fulfillable)} / {text(summary?.reserved)} / {text(summary?.inbound)}</b><span>来自 FBA inventory 汇总</span></div><div><small>待处理工作项</small><b>—</b><span>由任务与异常服务返回</span></div><div><small>开放 Inbound Plan</small><b>{text(summary?.openInbound)}</b><span>Shipment / Receiving</span></div><div><small>待退货与赔付</small><b>{text(summary?.openReturns)}</b><span>需要关联证据</span></div><div><small>FBA 费用事件</small><b>{summary?.feeTotal === undefined ? '—' : `$${number(summary.feeTotal).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</b><span>当前结算周期</span></div></div>}
    {error && <div className="fba-error"><b>数据加载失败</b><span>{error}</span><button className="link-button" onClick={() => setRefreshKey(value => value + 1)}>重试</button></div>}
    {module === 'overview' ? <div className="fba-overview-grid"><section className="table-panel"><div className="table-head"><div><h3>运营工作队列</h3><span className="table-subtitle">业务对象和任务由服务端返回</span></div><span className="fba-count">{filteredRows.length} 个对象</span></div><div className="table-scroll"><table className="data-table fba-object-table"><thead><tr>{columns('overview').map(([, label]) => <th key={label}>{label}</th>)}<th>操作</th></tr></thead><tbody>{filteredRows.map(row => <tr key={text(row.id)} onClick={() => setSelected(row)}>{columns('overview').map(([key]) => <td key={key}>{displayValue(key, row[key])}</td>)}<td><button className="link-button" onClick={() => setSelected(row)}>打开对象</button></td></tr>)}</tbody></table></div>{!loading && !filteredRows.length && <div className="fba-empty"><b>暂无真实工作项</b><span>{error ? '先处理服务端连接问题。' : '完成 Amazon 授权并执行同步后，真实任务会在此出现。'}</span></div>}</section><aside className="fba-side-stack"><section className="panel"><div className="panel-head"><div><h3>执行入口</h3><span>每个动作都会进入服务端任务队列</span></div></div><button className="fba-action-row" onClick={() => setModal('inbound')}><span>＋</span><div><b>创建补货 / Inbound Plan</b><small>需要 Amazon US SP-API 连接和写入权限</small></div><i>→</i></button><button className="fba-action-row" onClick={() => setModal('sync')}><span>↻</span><div><b>同步 Amazon FBA 数据</b><small>按官方数据域创建服务端任务</small></div><i>→</i></button><button className="fba-action-row" onClick={() => setModal('report')}><span>▤</span><div><b>生成 FBA 报表</b><small>任务完成后才允许签发下载地址</small></div><i>→</i></button></section><section className="panel"><div className="panel-head"><div><h3>数据边界</h3><span>生产环境执行规则</span></div></div><dl className="fba-definition"><div><dt>对象来源</dt><dd>Amazon SP-API / Reports</dd></div><div><dt>写入动作</dt><dd>权限校验 → Queue → Audit</dd></div><div><dt>凭据</dt><dd>服务端加密存储，前端不可见</dd></div></dl></section></aside></div> : <><div className="fba-list-toolbar"><div className="fba-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 ASIN、SKU、Shipment、任务编号或业务对象" /></div><select value={status} onChange={event => setStatus(event.target.value)}><option>全部状态</option><option>正常</option><option>ACTIVE</option><option>已完成</option><option>运行中</option><option>失败</option><option>待核对</option><option>差异</option><option>低库存</option><option>授权待确认</option><option>未配置</option></select><span className="fba-result">匹配 {filteredRows.length} / {rows.length} 条记录</span><button className="outline-button" onClick={exportRows}>导出当前结果</button></div><div className="table-panel"><div className="table-head"><div><h3>{meta.title} · 对象列表</h3><span className="table-subtitle">所有行来自当前租户服务端查询</span></div><div className="fba-table-meta">{loading ? '正在读取…' : source ? '服务端查询完成' : '服务端未配置'} · {filteredRows.length} rows</div></div>{loading ? <div className="fba-empty">正在加载 {meta.title} 数据…</div> : !filteredRows.length ? <div className="fba-empty"><b>暂无真实记录</b><span>{error ? '请先修复服务端连接或权限。' : '完成对应数据域同步后，真实对象会显示在这里。'}</span></div> : <div className="table-scroll"><table className="data-table fba-object-table"><thead><tr>{columns(module).map(([, label]) => <th key={label}>{label}</th>)}<th>动作</th></tr></thead><tbody>{filteredRows.map(row => <tr key={text(row.id)} onClick={() => setSelected(row)}>{columns(module).map(([key]) => <td key={key}>{displayValue(key, row[key])}</td>)}<td onClick={event => event.stopPropagation()}><button className="link-button" onClick={() => setSelected(row)}>{module === 'sync' && text(row.status) === 'FAILED' ? '查看并重试' : '查看详情'}</button></td></tr>)}</tbody></table></div>}</div></>}
    {selected && <div className="fba-drawer-backdrop" onClick={() => setSelected(null)}><aside className="fba-detail-drawer" onClick={event => event.stopPropagation()}><div className="fba-drawer-head"><div><span className="fba-eyebrow">OBJECT DETAIL</span><h2>{text(selected.id)}</h2><small>{meta.title} · Amazon.com · 服务端记录</small></div><button className="close-button" onClick={() => setSelected(null)}>×</button></div><div className="fba-drawer-status">{tag(text(selected.status ?? selected.health ?? selected.state ?? '待处理'))}<span>最近更新：{text(selected.updatedAt ?? selected.checked ?? selected.startedAt ?? selected.returnDate)}</span></div><div className="fba-detail-grid">{Object.entries(selected).filter(([key]) => key !== 'id').slice(0, 16).map(([key, value]) => <div key={key}><small>{key}</small><b>{typeof value === 'object' ? JSON.stringify(value) : text(value)}</b></div>)}</div>{module === 'sync' && text(selected.status) === 'FAILED' && <div className="fba-drawer-alert"><b>失败原因</b><span>{text(selected.failureCode)}</span><button className="blue-button" onClick={() => retry(selected)}>重试该任务</button></div>}{(module === 'inventory' || module === 'products') && <button className="blue-button fba-drawer-action" onClick={() => { setSelected(null); setModal('inbound') }}>从该对象创建补货计划</button>}{module === 'connections' && <button className="outline-button fba-drawer-action" onClick={() => navigate('/app/sync')}>查看连接同步任务</button>}</aside></div>}
    {total > pageSize && <div className="fba-table-footer"><span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 · 共 {total} 条</span><div><button className="outline-button" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><button className="outline-button" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(value => Math.min(Math.ceil(total / pageSize), value + 1))}>下一页</button></div></div>}    {modal && <OperationModal kind={modal} sellerConnectionId={sellerConnectionId} adsConnectionId={adsConnectionId} defaultDomain={defaultDomain} defaultReportType={defaultReportType} onClose={() => setModal(null)} onDone={addRow} />}
  </div>
}
