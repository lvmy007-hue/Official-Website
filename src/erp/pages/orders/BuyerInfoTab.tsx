import { Alert } from 'antd'
import type { BuyerInfoState } from '@nova/api-contracts'
import { PiiField, type PiiFieldSpec } from '../../components'

// 买家信息页签（07 章 7.1 第 8 页签）：默认只显示遮罩，查看必须填写理由并写审计。
// 明文走全站唯一出口 POST /pii/reveal（P6-14），展示与自动隐藏由共享组件 PiiField 负责。

const STATE_NOTE: Record<Exclude<BuyerInfoState, 'AVAILABLE'>, string> = {
  EXPIRED: '买家信息已超过保留期，按亚马逊要求已清除，无法查看。',
  NOT_SYNCED: '这个订单的买家信息尚未同步（买家信息需要受限数据权限的订单报告，同步后才有）。',
}

const FIELDS: readonly PiiFieldSpec[] = [
  { name: 'buyerName', label: '姓名' },
  { name: 'buyerEmail', label: '邮箱' },
  { name: 'buyerPhone', label: '电话' },
  { name: 'addressLine1', label: '地址' },
  { name: 'city', label: '城市' },
  { name: 'state', label: '州或省' },
  { name: 'postalCode', label: '邮编' },
  { name: 'country', label: '国家或地区' },
]

export function BuyerInfoTab({ id, state, expiresAt }: { id: string; state: BuyerInfoState; expiresAt: string | null }) {
  return (
    <div>
      <PiiField
        objectType="ORDER"
        objectId={id}
        fields={FIELDS}
        available={state === 'AVAILABLE'}
        unavailableNote={state === 'AVAILABLE' ? null : <Alert type="info" showIcon message={STATE_NOTE[state]} />}
        retainedUntil={expiresAt}
        buttonLabel="查看买家信息"
        dialogTitle="查看买家信息"
        reasonPlaceholder="例如：客服处理该订单的退款咨询"
      />
    </div>
  )
}
