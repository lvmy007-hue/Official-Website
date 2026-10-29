import { Button, Typography } from 'antd'
import type { EnterpriseSettingsResponse, InternalAccessState } from '@nova/api-contracts'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useOptionalSession } from '../../session/session'
import { CardGrid, ConfigCard, SettingsLoader } from './settings-cards'

// 风险规则版本与内部访问模式（P5-10，09 章 9.12 第 5、6 个页签）。
// 风险规则的修改与版本历史在预警中心的“规则配置”页，这里给摘要和入口；内部访问模式由部署配置控制，只读展示。

const RULES_PATH = '/app/alerts/rules'

function RiskCards({ risk }: { risk: EnterpriseSettingsResponse['risk'] }) {
  const session = useOptionalSession()
  const canManage = session?.canPermission('alerts.manage') ?? false
  const last = risk.lastChange
  return (
    <CardGrid>
      <ConfigCard
        id="riskRules"
        name="风险规则"
        value={`共 ${risk.total} 条，已启用 ${risk.enabled} 条`}
        impact="预警中心里各类风险（断货、广告超支、费用异常等）的触发条件、阈值与通知对象。"
        note="每次修改规则都会生成新版本，保留修改前后的内容与修改人；版本历史在规则配置页查看。"
        readonlyBy={canManage ? undefined : '规则由有“管理预警规则”权限的成员维护，你没有这项权限。'}
        action={
          <AppLink to={RULES_PATH}>
            <Button>前往“预警规则配置”</Button>
          </AppLink>
        }
      />
      <ConfigCard
        id="riskLastChange"
        name="最近一次规则修改"
        value={last ? `${last.ruleName} · 第 ${last.versionNo} 版` : '还没有人修改过规则'}
        impact="用于确认规则最近有没有被调整；预警结果变多或变少时先看这里。"
        note={last ? `修改时间：${formatDateTime(last.changedAt)}` : undefined}
        readonlyBy="这里只记录结果，修改要到规则配置页进行。"
      />
    </CardGrid>
  )
}

const INTERNAL_VALUE: Record<InternalAccessState, string> = {
  OFF: '未开启',
  ON_THIS_TENANT: '已对本企业开启',
  ON_OTHER_TENANT: '未对本企业开启（部署指定了其他企业）',
  MISCONFIGURED: '部署配置有误，系统按未开启处理',
}

function InternalCards({ internal }: { internal: EnterpriseSettingsResponse['internal'] }) {
  const on = internal.state === 'ON_THIS_TENANT'
  return (
    <CardGrid>
      <ConfigCard
        id="internalAccess"
        name="内部访问模式"
        value={INTERNAL_VALUE[internal.state]}
        impact="开启后，运维人员可以用绑定的角色从指定网络进入本企业，所有请求都会记入审计日志。"
        note={
          on
            ? `绑定角色：${internal.roleId}；允许的网络范围 ${internal.allowedRangeCount} 段；${internal.gatewayHeaderRequired ? '要求网关校验头' : '不要求网关校验头'}。`
            : internal.state === 'MISCONFIGURED'
              ? '请联系运维检查部署里的内部访问配置。'
              : undefined
        }
        readonlyBy="由部署配置控制，企业管理员不能在页面开关；需要变更请联系平台运维。"
      />
      <ConfigCard
        id="supportGrants"
        name="平台支持访问授权"
        value={`当前有效 ${internal.supportGrantsActive} 个，正在被使用 ${internal.supportGrantsInUse} 个`}
        impact="平台人员只能在你授权的时限内查看本企业数据，领取后的每个请求都会记入审计。"
        note={<Typography.Text type="secondary">授权与撤销在个人菜单的“平台支持访问授权”里操作。</Typography.Text>}
        readonlyBy="由有授权权限的企业成员在个人菜单里授权，到期自动失效；这里只显示数量。"
      />
    </CardGrid>
  )
}

export function RiskTab() {
  return <SettingsLoader>{data => <RiskCards risk={data.risk} />}</SettingsLoader>
}

export function InternalTab() {
  return <SettingsLoader>{data => <InternalCards internal={data.internal} />}</SettingsLoader>
}
