import { useCallback, useState } from 'react'
import { Alert, Card, Checkbox, Col, Form, Radio, Row, Space, Tag } from 'antd'
import { BUSINESS_RULES_WRITE, FINANCE_POLICY_STEP_UP, type BusinessRuleCard, type BusinessRuleKey, type BusinessRulesResponse, type MetricSubmitResult } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { PendingAlert, VersionHistory } from './metric-versions-parts'

// 业务口径页（P6-31）：净销售额、可用库存、周起始日、多站点“今日”四项口径。
// 修改要提交、由另一位有权限的同事通过后才生效；已关账月份的快照不改动。

/** 每项口径的值在请求体里的字段名。 */
const FIELD: Record<BusinessRuleKey, string> = { netSales: 'deduct', availableInventory: 'components', weekStart: 'day', multiSiteToday: 'mode' }

const valueOf = (card: BusinessRuleCard, value: unknown): string[] | string => {
  const raw = (value as Record<string, unknown> | null)?.[FIELD[card.key]]
  return card.multiple ? (Array.isArray(raw) ? (raw as string[]) : []) : String(raw ?? '')
}

function RuleCard({ card, data, onDone }: { card: BusinessRuleCard; data: BusinessRulesResponse; onDone: () => void }) {
  const editable = data.pending === null
  return (
    <Card
      size="small"
      title={card.label}
      data-testid={`rule-${card.key}`}
      extra={
        card.pendingValue ? (
          <Tag color="warning" bordered={false}>
            有待审批的修改
          </Tag>
        ) : null
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <div>
          <Muted>当前值：</Muted>
          <strong>{card.valueText}</strong>
        </div>
        <Muted>{`系统默认：${card.defaultText}`}</Muted>
        <div>
          <Muted>影响范围：</Muted>
          {card.impact.join('、')}
        </div>
        <FormAction
          label="编辑"
          title={`修改业务口径：${card.label}`}
          okText="提交审批"
          guard={{ permission: BUSINESS_RULES_WRITE, condition: { ok: editable, reason: '已有待审批的修改，请先处理' } }}
          stepUp={FINANCE_POLICY_STEP_UP}
          reason={{ label: '修改原因' }}
          buttonProps={{ size: 'small' }}
          initialValues={{ value: valueOf(card, card.value) }}
          description="提交后需要另一位有权限的同事通过才生效；通过前仍按当前口径计算。"
          successText="已提交，等待另一位有权限的同事审批"
          onSubmit={async values =>
            apiFetch<MetricSubmitResult>(`/settings/business-rules/${card.key}`, {
              method: 'PUT',
              body: JSON.stringify({ version: data.latestVersionNo, value: { [FIELD[card.key]]: values.value }, reason: values.reason }),
            })
          }
          onDone={onDone}
        >
          <Form.Item name="value" label="新的取值">
            {card.multiple ? <Checkbox.Group options={card.options} /> : <Radio.Group options={card.options} />}
          </Form.Item>
        </FormAction>
      </Space>
    </Card>
  )
}

export default function BusinessRulesPage() {
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(current => current + 1), [])
  const query = useApiQuery<BusinessRulesResponse>({ domain: 'config', path: '/settings/business-rules', params: { tick } })
  const data = query.data ?? null
  return (
    <div data-testid="business-rules-page">
      <PageHeader title="业务口径" description="净销售额、可用库存、周起始日、多站点“今日”怎么算。修改要由另一位有权限的同事审批；已关账月份不改动。" />
      {query.error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={query.error.message} /> : null}
      {data ? (
        <>
          <PendingAlert pending={data.pending} onDone={refresh} />
          {data.writeBlockedReason ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={data.writeBlockedReason} /> : null}
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`当前口径：${data.current.source === 'DEFAULT' ? '系统默认' : `第 ${data.current.versionNo} 版`}`}
            description={data.note}
          />
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            {data.cards.map(card => (
              <Col key={card.key} xs={24} md={12}>
                <RuleCard card={card} data={data} onDone={refresh} />
              </Col>
            ))}
          </Row>
        </>
      ) : null}
      <Card size="small" title="版本历史">
        <VersionHistory kind="BUSINESS_RULES" tick={tick} onDone={refresh} />
      </Card>
    </div>
  )
}
