import { Alert, Card, Space, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { type ConnectionCenterResponse, type ModuleState, type RoleModuleView, type RoleView } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { AppLink } from '../../nav/AppLink'

// 角色对照（P5-04，09 章 9.6）：把应用已获授权的卖家接口角色与各板块所需角色逐项对照，缺哪个、影响哪些页面一目了然。
// 亚马逊没有“查询已授权角色”的接口，所以按各板块最近一次同步的结果推断：能取到数据＝具备；被拒绝＝缺角色；没有记录＝尚未验证。
// 官方写的“所需角色”是“至少具备其一”，只有只依赖单个角色的板块才能据以验证那个角色。

const COLOR: Record<ModuleState, string> = { GRANTED: 'success', PARTIAL: 'warning', MISSING: 'error', NOT_APPLICABLE: 'default', UNVERIFIED: 'default' }

const columns: ColumnsType<RoleModuleView> = [
  { title: '功能板块', dataIndex: 'label', key: 'label', width: 170 },
  {
    title: '所需角色（至少具备其一）',
    key: 'roles',
    width: 260,
    render: (_value, row) => (
      <Space size={[4, 4]} wrap>
        {row.roles.map(role => (
          <Tag key={role.name} bordered={false} style={{ marginInlineEnd: 0 }}>
            {role.label}
          </Tag>
        ))}
      </Space>
    ),
  },
  {
    title: '对照结果',
    key: 'state',
    width: 190,
    render: (_value, row) => (
      <div>
        <Tag color={COLOR[row.state]} bordered={false} style={{ marginInlineEnd: 0 }}>
          {row.stateLabel}
        </Tag>
        <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
          已打通 {row.counts.ok} / 缺角色 {row.counts.missing} / 未验证 {row.counts.unverified}，共 {row.storeCount} 家店铺
        </div>
      </div>
    ),
  },
  {
    title: '影响的页面',
    key: 'pages',
    render: (_value, row) => (
      <div>
        <Space size={[8, 4]} wrap>
          {row.pages.map(page => (
            <AppLink key={page.path} to={page.path}>
              {page.title}
            </AppLink>
          ))}
        </Space>
        {row.impact ? (
          <div role="note" style={{ color: '#cf1322', fontSize: 12, marginTop: 4 }}>
            {row.impact}
          </div>
        ) : null}
      </div>
    ),
  },
]

const ROLE_COLOR = { VERIFIED: 'success', PARTIAL: 'warning', MISSING: 'error', NOT_APPLICABLE: 'default', UNVERIFIED: 'default', NOT_DIRECTLY_VERIFIABLE: 'default' } as const

const roleColumns: ColumnsType<RoleView> = [
  {
    title: '角色',
    key: 'label',
    width: 260,
    render: (_value, row) => (
      <span>
        {row.label}
        {row.restricted ? <Tag style={{ marginInlineStart: 6 }}>受限角色</Tag> : null}
      </span>
    ),
  },
  {
    title: '状态',
    key: 'state',
    width: 160,
    render: (_value, row) => (
      <Tag color={ROLE_COLOR[row.state]} bordered={false} style={{ marginInlineEnd: 0 }}>
        {row.stateLabel}
      </Tag>
    ),
  },
  { title: '哪些板块要用它', key: 'usedBy', render: (_value, row) => (row.usedBy.length ? row.usedBy.join('、') : '—') },
]

export function RoleComparison({ roles }: { roles: ConnectionCenterResponse['roles'] }) {
  const missing = roles.modules.filter(module => module.state === 'MISSING' || module.state === 'PARTIAL')
  return (
    <Card size="small" title="角色对照" style={{ marginTop: 16 }} data-testid="role-comparison">
      <p style={{ margin: '0 0 8px', color: 'rgba(0,0,0,0.65)' }}>{roles.basis}</p>
      {roles.storeCount === 0 ? (
        <Alert type="info" showIcon message="还没有已授权的卖家店铺，授权后才能对照角色。" />
      ) : (
        <>
          {missing.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={`有 ${missing.length} 个功能板块缺少所需角色：${missing.map(module => module.label).join('、')}。到卖家平台的应用授权里补充角色后，重新授权即可。`}
            />
          ) : null}
          <SimpleGrid<RoleModuleView>
            gridId="connections.role-comparison"
            columns={columns}
            rows={roles.modules}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '角色对照', prerequisite: '没有板块。' }}
          />
          <h4 style={{ margin: '12px 0 4px' }}>角色逐项</h4>
          <SimpleGrid<RoleView>
            gridId="connections.role-compare"
            columns={roleColumns}
            rows={roles.roles}
            rowKey={row => row.name}
            emptyState={{ kind: 'empty', domain: '角色', prerequisite: '没有角色清单。' }}
          />
        </>
      )}
    </Card>
  )
}
