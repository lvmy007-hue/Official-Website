import { Button, Descriptions } from 'antd'
import { AppLink } from '../nav/AppLink'
import { StepFrame } from './StepFrame'
import type { StepPanelProps } from './onboarding-types'

// 需要到别的页面操作的步骤（P1-19）：法律主体、卖家授权、广告授权；以及写入开关确认。
// 这里不重复做那些页面的功能，只如实显示“前置条件是否已满足”，并给出入口；满足后才能完成这一步。

const TARGETS: Record<string, { to: string; label: string; text: string }> = {
  ENTITIES: { to: '/app/entities', label: '去登记法律主体', text: '在“法律主体”页登记运营店铺的公司或个体，每个店铺都挂在某个法律主体名下。' },
  SELLER_AUTH: { to: '/app/connections', label: '去授权卖家接口', text: '在“连接中心”授权亚马逊美国站店铺。授权后才能同步订单、库存与财务；所有店铺均为品牌卖家。' },
  ADS_AUTH: { to: '/app/connections', label: '去授权广告接口', text: '在“连接中心”授权广告账户，并把广告账户绑定到对应店铺。没有广告业务可以跳过。' },
}

export function LinkStep({ step, busy, onSubmit }: StepPanelProps) {
  const target = TARGETS[step.key]
  return (
    <StepFrame step={step} busy={busy} onComplete={() => onSubmit('COMPLETE')} onSkip={action => onSubmit(action)} completeText="我已完成，继续">
      <p>{target.text}</p>
      <AppLink to={target.to} keepScope={false}>
        <Button>{target.label}</Button>
      </AppLink>
    </StepFrame>
  )
}

export function WriteSwitchesStep({ step, busy, onSubmit }: StepPanelProps) {
  return (
    <StepFrame step={step} busy={busy} onComplete={() => onSubmit('COMPLETE')} completeText="确认保持只读，完成">
      <Descriptions size="small" column={1} bordered style={{ maxWidth: 560 }}>
        <Descriptions.Item label="当前状态">所有数据域的亚马逊写入开关均为关闭（只读）</Descriptions.Item>
        <Descriptions.Item label="含义">所有改动只做预览与记录，不会改动亚马逊；顶栏会一直显示“只读模式”</Descriptions.Item>
        <Descriptions.Item label="如何开启">需要写入时，到“接口与写入开关”页面按数据域单独开启，开启需要再次验证身份，并留有审计记录</Descriptions.Item>
      </Descriptions>
    </StepFrame>
  )
}
