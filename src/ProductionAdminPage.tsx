import { useEffect, useState } from 'react'
import { Message } from '@arco-design/web-react'
import { IconArrowRight, IconFile, IconPlus, IconSearch, IconSettings, IconUser } from '@arco-design/web-react/icon'
import { apiFetch } from './api'

type AdminKind = 'entities' | 'members' | 'audit' | 'settings' | 'profile' | 'ads' | 'ads-reports' | 'ads-metrics' | 'contacts' | 'procurement'
type Row = Record<string, unknown>

const meta: Record<AdminKind, { title: string; subtitle: string; kicker: string }> = {
  entities: { title: '法律主体', subtitle: '主体、店铺和授权范围的企业边界。', kicker: 'LEGAL ENTITIES · GOVERNANCE' },
  members: { title: '成员与角色', subtitle: '按租户返回真实成员、角色和权限范围。', kicker: 'MEMBERS · RBAC' },
  audit: { title: '审计中心', subtitle: '真实记录操作者、请求链路、资源和执行结果。', kicker: 'AUDIT · EVIDENCE' },
  settings: { title: '企业设置', subtitle: '企业资料和运行策略读取自当前企业服务端配置。', kicker: 'TENANT · SETTINGS' },
  profile: { title: '个人账号', subtitle: '当前登录账号和所在企业范围。', kicker: 'ACCOUNT · SECURITY' },
  ads: { title: 'Amazon Ads 活动', subtitle: '广告对象必须来自 Amazon Ads API 授权 Profile。', kicker: 'AMAZON ADS · CAMPAIGNS' },
  'ads-reports': { title: 'Amazon Ads 报表', subtitle: '报表任务必须来自 Amazon Ads API，未授权时不展示虚构记录。', kicker: 'AMAZON ADS · REPORTS' },
  'ads-metrics': { title: 'Amazon Ads 数据', subtitle: '按日、按 Campaign 保存报表指标，支持经营分析和导出。', kicker: 'AMAZON ADS · METRICS' },
  contacts: { title: '官网线索', subtitle: '官网提交的企业需求进入服务端队列，支持状态跟进。', kicker: 'WEBSITE · CONTACT REQUESTS' },
  procurement: { title: '采购订单', subtitle: '供应商、采购单、采购行和到货数量由企业服务端维护。', kicker: 'PROCUREMENT · PURCHASE ORDERS' },
}

function go(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }
async function connectAds() { try { const result = await apiFetch<{ authorizationUrl: string }>('/ads/oauth/start', { method: 'POST', body: '{}' }); window.location.assign(result.authorizationUrl) } catch (error) { Message.error(error instanceof Error ? error.message : 'Amazon Ads 授权失败') } }
async function syncAds() { try { await apiFetch('/ads/sync', { method: 'POST', body: '{}' }); Message.success('Ads Profile 同步任务已提交'); window.setTimeout(() => window.location.reload(), 500) } catch (error) { Message.error(error instanceof Error ? error.message : 'Ads 同步失败') } }
function value(row: Row | undefined, key: string, fallback = '—') { const item = row?.[key]; return item === null || item === undefined || item === '' ? fallback : String(item) }
function status(value: string) { return <span className={`tag ${/FAILED|失败|ERROR|异常/.test(value) ? 'bad' : /PENDING|待|INVITED|授权/.test(value) ? 'warn' : 'good'}`}><i className="status-dot" />{value}</span> }function AdsReportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [profiles, setProfiles] = useState<Row[]>([])
  const [profileId, setProfileId] = useState('')
  const [reportType, setReportType] = useState('spCampaigns')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void apiFetch<Row[]>('/ads/profiles').then(items => {
      if (!alive) return
      setProfiles(items)
      setProfileId(String(items[0]?.id ?? ''))
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Profile 读取失败') }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  const submit = async () => {
    if (!profileId) { setError('请先同步至少一个 Amazon Ads Profile'); return }
    setBusy(true); setError('')
    try {
      await apiFetch('/ads/reports', { method: 'POST', body: JSON.stringify({ profileId, reportType, adProduct: 'SPONSORED_PRODUCTS', ...(from ? { from } : {}), ...(to ? { to } : {}) }) })
      Message.success('广告报表任务已提交，完成后可在当前列表下载')
      onDone()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '广告报表提交失败') } finally { setBusy(false) }
  }
  return <div className="production-modal-backdrop" onClick={onClose}><section className="production-modal" role="dialog" aria-modal="true" aria-labelledby="ads-report-title" onClick={event => event.stopPropagation()}>
    <div className="production-modal-head"><div><span className="eyebrow">AMAZON ADS · REPORTING</span><h2 id="ads-report-title">创建广告报表任务</h2><p>任务进入服务端队列，由 Amazon Ads Reporting API 生成。</p></div><button className="close-button" onClick={onClose}>×</button></div>
    {loading ? <div className="production-state"><b>正在读取 Ads Profile…</b><span>不会在 Profile 未同步时创建虚假报表。</span></div> : <div className="production-form-grid"><label>Profile<select value={profileId} onChange={event => setProfileId(event.target.value)} disabled={!profiles.length}><option value="">选择 Profile</option>{profiles.map(profile => <option key={String(profile.id)} value={String(profile.id)}>{value(profile, 'displayName', value(profile, 'profileId'))} · {value(profile, 'marketplaceId', 'Amazon.com')}</option>)}</select></label><label>报表类型<select value={reportType} onChange={event => setReportType(event.target.value)}><option value="spCampaigns">Campaign performance</option><option value="spSearchTerm">Search term performance</option><option value="spAdvertisedProduct">Advertised product performance</option></select></label><label>开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>结束日期<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div>}
    {error && <div className="production-state production-state-error"><b>提交前校验未通过</b><span>{error}</span></div>}
    <div className="production-modal-foot"><span>需要 Ads 公有应用授权和 seller.write 权限。</span><button className="outline-button" onClick={onClose}>取消</button><button className="blue-button" disabled={busy || loading || !profiles.length} onClick={() => void submit()}>{busy ? '提交中…' : '创建报表任务'}</button></div>
  </section></div>
}

export function ProductionAdminPage({ kind }: { kind: AdminKind }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [payload, setPayload] = useState<unknown>(null)
  const [reportModal, setReportModal] = useState(false)
  const current = meta[kind]

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true); setError('')
      try {
        const endpoint = kind === 'entities' ? '/entities' : kind === 'members' ? '/members' : kind === 'audit' ? '/audit?page=1&pageSize=100' : kind === 'ads' ? '/ads/campaigns?page=1&pageSize=100' : kind === 'ads-reports' ? '/ads/reports?page=1&pageSize=100' : kind === 'ads-metrics' ? '/ads/metrics?page=1&pageSize=100' : kind === 'contacts' ? '/contact-requests' : kind === 'procurement' ? '/procurement/purchase-orders' : '/auth/me'
        const result = await apiFetch<unknown>(endpoint)
        if (alive) setPayload(result)
      } catch (reason) {
        if (alive) { setPayload(null); setError(reason instanceof Error ? reason.message : '服务端数据读取失败') }
      } finally { if (alive) setLoading(false) }
    }
    void load()
    return () => { alive = false }
  }, [kind])

  const emptyAction = kind === 'ads-reports' ? <><button className="outline-button" onClick={() => void syncAds()}><IconArrowRight /> 同步 Profile</button><button className="outline-button" onClick={() => setReportModal(true)}><IconFile /> 创建报表</button><button className="blue-button" onClick={() => void connectAds()}><IconPlus /> 授权 Amazon Ads</button></> : kind === 'ads' ? <><button className="outline-button" onClick={() => void syncAds()}><IconArrowRight /> 同步 Profile</button><button className="blue-button" onClick={() => void connectAds()}><IconPlus /> 授权 Amazon Ads</button></> : undefined
  return <div className="page-body production-admin-page">
    <div className="production-admin-head"><div><span className="eyebrow">{current.kicker}</span><h1>{current.title}</h1><p>{current.subtitle}</p></div><div className="page-actions">{emptyAction ?? <button className="outline-button" onClick={() => window.location.reload()}><IconArrowRight /> 刷新服务端数据</button>}</div></div>
    {loading && <div className="production-state"><b>正在读取服务端数据…</b><span>当前页面不会使用本地示例记录。</span></div>}
    {!loading && error && <div className="production-state production-state-error"><b>服务端数据返回错误</b><span>{error}</span><button className="link-button" onClick={() => kind === 'ads' || kind === 'ads-reports' ? go('/app/connections') : window.location.reload()}>处理连接问题 <IconArrowRight /></button></div>}
    {!loading && !error && kind === 'entities' && <EntityTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {!loading && !error && kind === 'members' && <MemberTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {!loading && !error && kind === 'audit' && <AuditTable rows={((payload as Row)?.items ?? []) as Row[]} />}
    {!loading && !error && kind === 'profile' && <ProfileCard data={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'settings' && <SettingsCard data={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'ads' && <AdsCampaignTable payload={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'ads-reports' && <AdsReportTable payload={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'ads-metrics' && <AdsMetricTable payload={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'contacts' && <ContactTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {!loading && !error && kind === 'procurement' && <PurchaseOrderTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {reportModal && <AdsReportModal onClose={() => setReportModal(false)} onDone={() => { setReportModal(false); window.location.reload() }} />}
  </div>
}

function EntityTable({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', registeredCountry: 'United States', registrationNo: '' })
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await apiFetch('/entities', { method: 'POST', body: JSON.stringify(form) })
      Message.success('法律主体已创建，现在可以发起 Amazon 公有应用授权')
      setOpen(false)
      window.location.reload()
    } catch (error) { Message.error(error instanceof Error ? error.message : '法律主体创建失败') } finally { setBusy(false) }
  }
  return <>
    <section className="table-panel production-record-panel"><div className="table-head"><div><h3>当前企业法律主体</h3><span className="table-subtitle">数据由企业租户权限过滤 · 授权前必须先配置主体</span></div><div className="page-actions"><span className="status-note">{rows.length} 条记录</span><button className="blue-button" onClick={() => setOpen(true)}><IconPlus /> 新增法律主体</button></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>主体</th><th>注册国家 / 地区</th><th>注册编号</th><th>状态</th><th>动作</th></tr></thead><tbody>{rows.map(row => <tr key={value(row, 'id')}><td><b>{value(row, 'name')}</b><small className="cell-sub">{value(row, 'id')}</small></td><td>{value(row, 'registeredCountry')}</td><td>{value(row, 'registrationNo')}</td><td>{status(value(row, 'status'))}</td><td><button className="link-button" onClick={() => Message.info('主体范围可在连接授权时选择，数据和操作按租户隔离')}>查看范围</button></td></tr>)}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有配置法律主体。创建后即可发起 Amazon 公有应用授权。" />}</section>
    {open && <div className="production-modal-backdrop" onClick={() => setOpen(false)}><form className="production-modal" onClick={event => event.stopPropagation()} onSubmit={submit}><div className="production-modal-head"><div><span className="eyebrow">LEGAL ENTITY · ONBOARDING</span><h2>新增法律主体</h2><p>主体是 Seller 账号、连接授权和企业数据的边界。</p></div><button type="button" className="close-button" onClick={() => setOpen(false)}>×</button></div><div className="production-form-grid"><label>公司完整注册名称<input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：NOVA Commerce Inc." /></label><label>注册国家 / 地区<input required value={form.registeredCountry} onChange={event => setForm({ ...form, registeredCountry: event.target.value })} placeholder="例如：United States" /></label><label>企业注册编号（可选）<input value={form.registrationNo} onChange={event => setForm({ ...form, registrationNo: event.target.value })} placeholder="营业执照 / 注册编号" /></label></div><div className="production-modal-foot"><span>不会在前端保存 Amazon Refresh Token。</span><button type="button" className="outline-button" onClick={() => setOpen(false)}>取消</button><button className="blue-button" disabled={busy}>{busy ? '创建中…' : '创建主体'}</button></div></form></div>}
  </>
}
function MemberTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>租户成员</h3><span className="table-subtitle">角色和状态来自服务端 RBAC</span></div><span className="status-note">{rows.length} 条记录</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>成员</th><th>企业邮箱</th><th>角色</th><th>账号状态</th><th>成员关系</th><th>最近变更</th></tr></thead><tbody>{rows.map(row => { const user = (row.user ?? {}) as Row; const role = (row.role ?? {}) as Row; return <tr key={value(row, 'id')}><td><b>{value(user, 'displayName')}</b></td><td>{value(user, 'email')}</td><td><span className="role-pill">{value(role, 'name')}</span></td><td>{status(value(user, 'status'))}</td><td>{status(value(row, 'status'))}</td><td>{value(user, 'updatedAt')}</td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有成员记录。" />}</section>
}

function AuditTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>追加式操作记录</h3><span className="table-subtitle">记录来源于 API / Worker 的真实审计事件</span></div><div className="filter-bar"><IconSearch /><input placeholder="筛选由服务端实现" disabled /><button className="outline-button" disabled><IconFile /> 导出</button></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th><th>结果</th><th>Request ID</th></tr></thead><tbody>{rows.map(row => { const actor = (row.actor ?? {}) as Row; return <tr key={value(row, 'id')}><td>{value(row, 'createdAt')}</td><td>{value(actor, 'displayName', '系统')}</td><td><b>{value(row, 'action')}</b></td><td>{value(row, 'resourceType')} · {value(row, 'resourceId')}</td><td>{status(value(row, 'result'))}</td><td><span className="id-text">{value(row, 'requestId')}</span></td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有审计事件。完成授权或同步动作后，记录会在这里出现。" />}</section>
}

function ProfileCard({ data }: { data: Row }) { const user = (data.user ?? {}) as Row; const tenant = (data.tenant ?? {}) as Row; return <div className="production-admin-grid"><section className="panel production-detail-card"><span className="eyebrow">SIGNED-IN ACCOUNT</span><div className="production-profile-head"><span className="profile-avatar">{value(user, 'displayName', 'U').slice(0, 1)}</span><div><h2>{value(user, 'displayName')}</h2><p>{value(user, 'email')}</p>{status('ACTIVE')}</div></div><dl className="detail-grid"><dt>账号 ID</dt><dd>{value(user, 'id')}</dd><dt>企业</dt><dd>{value(tenant, 'name')}</dd><dt>企业范围</dt><dd>{value(data, 'activeTenantId')}</dd></dl></section><section className="panel production-detail-card"><div className="panel-head"><div><h3>安全边界</h3><span>敏感凭据不会返回前端</span></div><IconSettings /></div><p className="production-copy">登录会话由服务端签发，Amazon Refresh Token 只保存在服务端加密库中。个人密码、Token 原文和其他企业成员数据不会在当前页面展示。</p><button className="outline-button" onClick={() => Message.info('修改密码接口需由管理员在生产环境启用')}>管理登录安全</button></section></div> }

function SettingsCard({ data }: { data: Row }) { const tenant = (data.tenant ?? {}) as Row; return <div className="production-admin-grid"><section className="panel production-detail-card"><div className="panel-head"><div><h3>企业资料</h3><span>当前租户的服务端配置</span></div><IconSettings /></div><dl className="detail-grid"><dt>企业名称</dt><dd>{value(tenant, 'name')}</dd><dt>企业标识</dt><dd>{value(tenant, 'slug')}</dd><dt>运行模式</dt><dd>{value(tenant, 'mode')}</dd><dt>默认时区</dt><dd>{value(tenant, 'timezone')}</dd><dt>默认币种</dt><dd>{value(tenant, 'defaultCurrency')}</dd></dl></section><section className="panel production-detail-card"><div className="panel-head"><div><h3>生产策略</h3><span>只展示服务端已启用的能力</span></div><IconUser /></div><div className="production-list"><div><b>数据源</b><span>Amazon SP-API / Reports</span></div><div><b>凭据存储</b><span>服务端加密，前端不可见</span></div><div><b>审计</b><span>API 与 Worker 写入 AuditEvent</span></div><div><b>演示数据</b><span>生产模式禁止回退</span></div></div></section></div> }

function AdsCampaignTable({ payload }: { payload: Row }) {
  const rows = (Array.isArray(payload.items) ? payload.items : []) as Row[]
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>广告活动</h3><span className="table-subtitle">数据来自 Amazon Ads API · Sponsored Products</span></div><span className="status-note">共 {value(payload, 'total', '0')} 条</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>活动</th><th>Profile / 站点</th><th>状态</th><th>预算</th><th>最近同步</th></tr></thead><tbody>{rows.map(row => { const profile = (row.adsProfile ?? {}) as Row; return <tr key={value(row, 'id')}><td><b>{value(row, 'name')}</b><small className="cell-sub">{value(row, 'externalCampaignId')}</small></td><td>{value(profile, 'displayName', value(profile, 'profileId'))} · {value(profile, 'marketplaceId')}</td><td>{status(value(row, 'state'))}</td><td>{value(row, 'budget')} {value(row, 'currency', 'USD')}</td><td>{value(row, 'sourceUpdatedAt')}</td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="已连接 Ads 但还没有同步到活动记录。请在连接中心执行一次广告 Profile 同步。" />}</section>
}

function AdsReportTable({ payload }: { payload: Row }) {
  const rows = (Array.isArray(payload.items) ? payload.items : []) as Row[]
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>广告报表任务</h3><span className="table-subtitle">每个任务都有 Amazon report ID、状态和失败原因</span></div><span className="status-note">共 {value(payload, 'total', '0')} 条</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>报表类型</th><th>Profile</th><th>期间</th><th>状态</th><th>Amazon Report ID</th><th>结果</th></tr></thead><tbody>{rows.map(row => { const profile = (row.adsProfile ?? {}) as Row; return <tr key={value(row, 'id')}><td><b>{value(row, 'reportType')}</b><small className="cell-sub">{value(row, 'adProduct')}</small></td><td>{value(profile, 'displayName', value(profile, 'profileId'))}</td><td>{value(row, 'fromDate')} → {value(row, 'toDate')}</td><td>{status(value(row, 'status'))}</td><td><span className="id-text">{value(row, 'externalReportId')}</span></td><td>{value(row, 'downloadUrl')}</td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="还没有广告报表任务。授权并同步 Ads Profile 后即可创建真实报表。" />}</section>
}

function AdsMetricTable({ payload }: { payload: Row }) {
  const rows = (Array.isArray(payload.items) ? payload.items : []) as Row[]
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>广告经营数据</h3><span className="table-subtitle">Amazon Ads Reporting API 导入的按日 Campaign 指标</span></div><span className="status-note">共 {value(payload, 'total', '0')} 条</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>日期</th><th>Campaign</th><th>Profile</th><th>曝光</th><th>点击</th><th>花费</th><th>销售额</th><th>订单</th><th>ACOS</th></tr></thead><tbody>{rows.map(row => { const impressions = Number(row.impressions ?? 0); const sales = Number(row.sales ?? 0); const cost = Number(row.cost ?? 0); const profile = (row.adsProfile ?? {}) as Row; return <tr key={value(row, 'id')}><td>{value(row, 'reportDate')}</td><td><b>{value(row, 'campaignName', value(row, 'externalCampaignId'))}</b></td><td>{value(profile, 'displayName', value(profile, 'profileId'))}</td><td>{impressions.toLocaleString()}</td><td>{Number(row.clicks ?? 0).toLocaleString()}</td><td>{cost.toFixed(2)} {value(row, 'currency', 'USD')}</td><td>{sales.toFixed(2)} {value(row, 'currency', 'USD')}</td><td>{value(row, 'purchases', '0')}</td><td>{sales > 0 ? ((cost / sales) * 100).toFixed(1) + '%' : '—'}</td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="广告报表完成并导入后，按日指标会出现在这里。" />}</section>
}

function ContactTable({ rows }: { rows: Row[] }) {
  const [busy, setBusy] = useState('')
  const update = async (id: string, statusValue: string) => {
    setBusy(id)
    try { await apiFetch('/contact-requests/' + id, { method: 'PATCH', body: JSON.stringify({ status: statusValue }) }); Message.success('线索状态已更新') } catch (error) { Message.error(error instanceof Error ? error.message : '状态更新失败') } finally { setBusy('') }
  }
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>官网企业线索</h3><span className="table-subtitle">来源：官网联系表单 · 状态由企业团队维护</span></div><span className="status-note">{rows.length} 条记录</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>提交时间</th><th>联系人</th><th>企业</th><th>邮箱</th><th>电话</th><th>咨询类型</th><th>店铺规模</th><th>状态</th><th>动作</th></tr></thead><tbody>{rows.map(row => <tr key={value(row, 'id')}><td>{value(row, 'createdAt')}</td><td><b>{value(row, 'name')}</b></td><td>{value(row, 'company')}</td><td>{value(row, 'email')}</td><td>{value(row, 'phone')}</td><td>{value(row, 'topic')}</td><td>{value(row, 'storeBand')}</td><td>{status(value(row, 'status'))}</td><td><select value={value(row, 'status', 'NEW')} disabled={busy === value(row, 'id')} onChange={event => void update(value(row, 'id'), event.target.value)}><option>NEW</option><option>IN_PROGRESS</option><option>QUALIFIED</option><option>CLOSED</option><option>SPAM</option></select></td></tr>)}</tbody></table></div>{!rows.length && <EmptyRecord text="官网还没有企业线索提交。" />}</section>
}

function PurchaseOrderTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>采购订单</h3><span className="table-subtitle">供应商、预计到货、采购行和已收数量</span></div><span className="status-note">{rows.length} 条记录</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>采购单号</th><th>供应商</th><th>状态</th><th>币种</th><th>金额</th><th>预计到货</th><th>采购行</th><th>动作</th></tr></thead><tbody>{rows.map(row => { const supplier = (row.supplier ?? {}) as Row; const lines = Array.isArray(row.lines) ? row.lines as Row[] : []; return <tr key={value(row, 'id')}><td><b className="id-text">{value(row, 'number')}</b></td><td>{value(supplier, 'name')}</td><td>{status(value(row, 'status'))}</td><td>{value(row, 'currency')}</td><td>{value(row, 'totalAmount')}</td><td>{value(row, 'expectedDate')}</td><td>{lines.length}</td><td><button className="link-button" onClick={() => Message.info('采购单详情已打开')}>查看详情</button></td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="暂无采购订单。先配置供应商后创建采购单。" />}</section>
}
function EmptyRecord({ text }: { text: string }) { return <div className="production-empty"><b>暂无真实记录</b><span>{text}</span></div> }
