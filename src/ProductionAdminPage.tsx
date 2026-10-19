import { useEffect, useState } from 'react'
import { Message } from '@arco-design/web-react'
import { IconArrowRight, IconFile, IconPlus, IconSearch, IconSettings, IconUser } from '@arco-design/web-react/icon'
import { apiFetch } from './api'

type AdminKind = 'entities' | 'members' | 'audit' | 'settings' | 'profile' | 'ads' | 'ads-reports'
type Row = Record<string, unknown>

const meta: Record<AdminKind, { title: string; subtitle: string; kicker: string }> = {
  entities: { title: '法律主体', subtitle: '主体、店铺和授权范围的企业边界。', kicker: 'LEGAL ENTITIES · GOVERNANCE' },
  members: { title: '成员与角色', subtitle: '按租户返回真实成员、角色和权限范围。', kicker: 'MEMBERS · RBAC' },
  audit: { title: '审计中心', subtitle: '真实记录操作者、请求链路、资源和执行结果。', kicker: 'AUDIT · EVIDENCE' },
  settings: { title: '企业设置', subtitle: '企业资料和运行策略读取自当前企业服务端配置。', kicker: 'TENANT · SETTINGS' },
  profile: { title: '个人账号', subtitle: '当前登录账号和所在企业范围。', kicker: 'ACCOUNT · SECURITY' },
  ads: { title: 'Amazon Ads 活动', subtitle: '广告对象必须来自 Amazon Ads API 授权 Profile。', kicker: 'AMAZON ADS · CAMPAIGNS' },
  'ads-reports': { title: 'Amazon Ads 报表', subtitle: '报表任务必须来自 Amazon Ads API，未授权时不展示虚构记录。', kicker: 'AMAZON ADS · REPORTS' },
}

function go(path: string) { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }
function value(row: Row | undefined, key: string, fallback = '—') { const item = row?.[key]; return item === null || item === undefined || item === '' ? fallback : String(item) }
function status(value: string) { return <span className={`tag ${/FAILED|失败|ERROR|异常/.test(value) ? 'bad' : /PENDING|待|INVITED|授权/.test(value) ? 'warn' : 'good'}`}><i className="status-dot" />{value}</span> }

export function ProductionAdminPage({ kind }: { kind: AdminKind }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [payload, setPayload] = useState<unknown>(null)
  const current = meta[kind]

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true); setError('')
      try {
        if (kind === 'ads' || kind === 'ads-reports') throw new Error('Amazon Ads API 尚未配置，当前企业没有可读取的 Ads Profile')
        const endpoint = kind === 'entities' ? '/entities' : kind === 'members' ? '/members' : kind === 'audit' ? '/audit?page=1&pageSize=100' : '/auth/me'
        const result = await apiFetch<unknown>(endpoint)
        if (alive) setPayload(result)
      } catch (reason) {
        if (alive) { setPayload(null); setError(reason instanceof Error ? reason.message : '服务端数据读取失败') }
      } finally { if (alive) setLoading(false) }
    }
    void load()
    return () => { alive = false }
  }, [kind])

  const emptyAction = kind === 'ads' || kind === 'ads-reports' ? <button className="blue-button" onClick={() => go('/app/connections')}><IconPlus /> 配置 Amazon Ads 连接</button> : undefined
  return <div className="page-body production-admin-page">
    <div className="production-admin-head"><div><span className="eyebrow">{current.kicker}</span><h1>{current.title}</h1><p>{current.subtitle}</p></div><div className="page-actions">{emptyAction ?? <button className="outline-button" onClick={() => window.location.reload()}><IconArrowRight /> 刷新服务端数据</button>}</div></div>
    {loading && <div className="production-state"><b>正在读取服务端数据…</b><span>当前页面不会使用本地示例记录。</span></div>}
    {!loading && error && <div className="production-state production-state-error"><b>当前功能不可用</b><span>{error}</span><button className="link-button" onClick={() => kind === 'ads' || kind === 'ads-reports' ? go('/app/connections') : window.location.reload()}>处理连接问题 <IconArrowRight /></button></div>}
    {!loading && !error && kind === 'entities' && <EntityTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {!loading && !error && kind === 'members' && <MemberTable rows={Array.isArray(payload) ? payload as Row[] : []} />}
    {!loading && !error && kind === 'audit' && <AuditTable rows={((payload as Row)?.items ?? []) as Row[]} />}
    {!loading && !error && kind === 'profile' && <ProfileCard data={(payload ?? {}) as Row} />}
    {!loading && !error && kind === 'settings' && <SettingsCard data={(payload ?? {}) as Row} />}
  </div>
}

function EntityTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>当前企业法律主体</h3><span className="table-subtitle">数据由企业租户权限过滤</span></div><span className="status-note">{rows.length} 条记录</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>主体</th><th>注册国家</th><th>状态</th><th>动作</th></tr></thead><tbody>{rows.map(row => <tr key={value(row, 'id')}><td><b>{value(row, 'name')}</b><small className="cell-sub">{value(row, 'id')}</small></td><td>{value(row, 'registeredCountry')}</td><td>{status(value(row, 'status'))}</td><td><button className="link-button" onClick={() => Message.info('主体详情动作将在服务端写入权限校验后开放')}>查看范围</button></td></tr>)}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有配置法律主体。Amazon 授权前必须先创建主体。" />}</section>
}

function MemberTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>租户成员</h3><span className="table-subtitle">角色和状态来自服务端 RBAC</span></div><span className="status-note">{rows.length} 条记录</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>成员</th><th>企业邮箱</th><th>角色</th><th>账号状态</th><th>成员关系</th><th>最近变更</th></tr></thead><tbody>{rows.map(row => { const user = (row.user ?? {}) as Row; const role = (row.role ?? {}) as Row; return <tr key={value(row, 'id')}><td><b>{value(user, 'displayName')}</b></td><td>{value(user, 'email')}</td><td><span className="role-pill">{value(role, 'name')}</span></td><td>{status(value(user, 'status'))}</td><td>{status(value(row, 'status'))}</td><td>{value(user, 'updatedAt')}</td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有成员记录。" />}</section>
}

function AuditTable({ rows }: { rows: Row[] }) {
  return <section className="table-panel production-record-panel"><div className="table-head"><div><h3>追加式操作记录</h3><span className="table-subtitle">记录来源于 API / Worker 的真实审计事件</span></div><div className="filter-bar"><IconSearch /><input placeholder="筛选由服务端实现" disabled /><button className="outline-button" disabled><IconFile /> 导出</button></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th><th>结果</th><th>Request ID</th></tr></thead><tbody>{rows.map(row => { const actor = (row.actor ?? {}) as Row; return <tr key={value(row, 'id')}><td>{value(row, 'createdAt')}</td><td>{value(actor, 'displayName', '系统')}</td><td><b>{value(row, 'action')}</b></td><td>{value(row, 'resourceType')} · {value(row, 'resourceId')}</td><td>{status(value(row, 'result'))}</td><td><span className="id-text">{value(row, 'requestId')}</span></td></tr> })}</tbody></table></div>{!rows.length && <EmptyRecord text="当前企业还没有审计事件。完成授权或同步动作后，记录会在这里出现。" />}</section>
}

function ProfileCard({ data }: { data: Row }) { const user = (data.user ?? {}) as Row; const tenant = (data.tenant ?? {}) as Row; return <div className="production-admin-grid"><section className="panel production-detail-card"><span className="eyebrow">SIGNED-IN ACCOUNT</span><div className="production-profile-head"><span className="profile-avatar">{value(user, 'displayName', 'U').slice(0, 1)}</span><div><h2>{value(user, 'displayName')}</h2><p>{value(user, 'email')}</p>{status('ACTIVE')}</div></div><dl className="detail-grid"><dt>账号 ID</dt><dd>{value(user, 'id')}</dd><dt>企业</dt><dd>{value(tenant, 'name')}</dd><dt>企业范围</dt><dd>{value(data, 'activeTenantId')}</dd></dl></section><section className="panel production-detail-card"><div className="panel-head"><div><h3>安全边界</h3><span>敏感凭据不会返回前端</span></div><IconSettings /></div><p className="production-copy">登录会话由服务端签发，Amazon Refresh Token 只保存在服务端加密库中。个人密码、Token 原文和其他企业成员数据不会在当前页面展示。</p><button className="outline-button" onClick={() => Message.info('修改密码接口需由管理员在生产环境启用')}>管理登录安全</button></section></div> }

function SettingsCard({ data }: { data: Row }) { const tenant = (data.tenant ?? {}) as Row; return <div className="production-admin-grid"><section className="panel production-detail-card"><div className="panel-head"><div><h3>企业资料</h3><span>当前租户的服务端配置</span></div><IconSettings /></div><dl className="detail-grid"><dt>企业名称</dt><dd>{value(tenant, 'name')}</dd><dt>企业标识</dt><dd>{value(tenant, 'slug')}</dd><dt>运行模式</dt><dd>{value(tenant, 'mode')}</dd><dt>默认时区</dt><dd>{value(tenant, 'timezone')}</dd><dt>默认币种</dt><dd>{value(tenant, 'defaultCurrency')}</dd></dl></section><section className="panel production-detail-card"><div className="panel-head"><div><h3>生产策略</h3><span>只展示服务端已启用的能力</span></div><IconUser /></div><div className="production-list"><div><b>数据源</b><span>Amazon SP-API / Reports</span></div><div><b>凭据存储</b><span>服务端加密，前端不可见</span></div><div><b>审计</b><span>API 与 Worker 写入 AuditEvent</span></div><div><b>演示数据</b><span>生产模式禁止回退</span></div></div></section></div> }

function EmptyRecord({ text }: { text: string }) { return <div className="production-empty"><b>暂无真实记录</b><span>{text}</span></div> }
