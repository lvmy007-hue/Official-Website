import { Alert, Card, Col, Descriptions, Row, Space, Timeline, Typography } from 'antd'
import { CALC_STATE_LABEL, INVENTORY_ACTION_LABEL, type InventoryDispositionResponse, type InventoryReplenishmentResponse, type AwdTabResponse } from '@nova/api-contracts'
import { EntityCollaboration, EstimateTag } from '../../components'
import { formatDateTime, formatMoney, formatNumber } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { QueryBody, useDetailQuery } from './detail-hooks'
import { CalcStepsView } from '../replenishment/replenishment-ui'
import { LiveLink, Muted, StateBlock } from './inventory-ui'

// 库存详情的“上游仓储、补货建议、处置建议、变更与审计”页签。

const money = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatMoney(value, 'USD', { digits: 2 })}</span>)
const qty = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)

/** 上游仓储页签：这个 SKU 在店铺 AWD 的最近一次库存快照，以及还没有完结的入库货件。没有数字的列显示“尚无记录”，不写 0。 */
export function AwdTab({ id }: { id: string }) {
  const query = useDetailQuery<AwdTabResponse>(id, 'awd')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {data.state !== 'OK' ? (
            <Alert
              type={data.state === 'NOT_CONNECTED' ? 'info' : 'warning'}
              showIcon
              message={data.state === 'NOT_APPLICABLE' ? '未开通亚马逊仓储分销' : data.state === 'NO_DATA' ? '尚无记录' : '尚未同步'}
              description={data.note ?? undefined}
            />
          ) : null}
          {data.stock ? (
            <Card size="small" title={`上游仓储库存（快照 ${data.snapshotDate ?? '—'}）`} data-testid="awd-stock">
              <Descriptions size="small" column={{ xs: 1, md: 3 }}>
                <Descriptions.Item label="可用">{qty(data.stock.availableQty)}</Descriptions.Item>
                <Descriptions.Item label="在库">{qty(data.stock.onhandQty)}</Descriptions.Item>
                <Descriptions.Item label="预留给补货">{qty(data.stock.reservedForReplenishment)}</Descriptions.Item>
                <Descriptions.Item label="入库中（到上游仓储）">{qty(data.stock.inboundToAwdQty)}</Descriptions.Item>
                <Descriptions.Item label="发往亚马逊物流在途">{qty(data.stock.outboundToFbaInTransit)}</Descriptions.Item>
                <Descriptions.Item label="最早到期日">{data.stock.expiryDate ?? <Muted>无</Muted>}</Descriptions.Item>
              </Descriptions>
            </Card>
          ) : null}
          {data.inboundShipments.length ? (
            <Card size="small" title="未完结的入库货件">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.inboundShipments.map(item => (
                  <li key={item.id}>
                    {item.orderRowId ? (
                      <LiveLink component="AwdOrderDetailPage" id={item.orderRowId}>
                        {item.shipmentId}
                      </LiveLink>
                    ) : (
                      item.shipmentId
                    )}
                    （{item.statusLabel}；预计 {item.expectedQty ?? '尚无记录'}、已接收 {item.receivedQty ?? '尚无记录'}
                    {item.unit && item.unit !== 'PRODUCT_UNITS' ? '，单位 ' + item.unit : ' 件'}）
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <LiveLink component="AwdPage" id="">
            查看上游仓储页
          </LiveLink>
        </Space>
      )}
    </QueryBody>
  )
}

export function ReplenishmentTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryReplenishmentResponse>(id, 'replenishment')
  return (
    <QueryBody query={query}>
      {data => (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
              <Card size="small" title="我方建议" data-testid="ours-card">
                {data.ours.state === 'OK' ? (
                  <Space direction="vertical" size={4}>
                    <div style={{ fontSize: 22, fontWeight: 600 }}>
                      {qty(data.ours.recommendedQty)} 件 <EstimateTag method="补货计算链（8 步），策略与预测见下方各步" />
                    </div>
                    <Typography.Text type="secondary">
                      下单日 {data.ours.orderDate ?? '—'}，到仓日 {data.ours.arriveDate ?? '—'}，采购量 {data.ours.purchaseQty} 件
                    </Typography.Text>
                    <LiveLink component="ReplenishmentPage" id="">
                      去补货建议页处理
                    </LiveLink>
                  </Space>
                ) : (
                  <Alert type={data.ours.state === 'NO_NEED' ? 'success' : 'info'} showIcon message={CALC_STATE_LABEL[data.ours.state]} description={data.ours.reason ?? undefined} />
                )}
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="亚马逊建议" data-testid="amazon-card">
                <StateBlock state={data.amazon.state} note={data.amazon.note}>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>{qty(data.amazon.recommendedQty)} 件</div>
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="建议发货日">{data.amazon.recommendedShipDate ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="提示原因">{data.amazon.alertReason ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="建议动作">{data.amazon.recommendedAction ?? '—'}</Descriptions.Item>
                    <Descriptions.Item label="来源">
                      {data.amazon.source === 'RESTOCK_REPORT' ? '补货建议报告' : '库存规划报告'}，快照 {data.amazon.snapshotDate ?? '—'}
                    </Descriptions.Item>
                  </Descriptions>
                </StateBlock>
              </Card>
            </Col>
          </Row>
          {data.ours.steps.length ? (
            <Card size="small" title="计算过程（每一步可展开看公式与输入）">
              <CalcStepsView steps={data.ours.steps} />
            </Card>
          ) : null}
          <Card size="small" title="差异">
            {data.diffQty === null ? (
              <Muted>两边任一方没有数量时不比较</Muted>
            ) : (
              <Typography.Paragraph>
                我方比亚马逊 {data.diffQty >= 0 ? '多' : '少'}建议 <strong>{Math.abs(data.diffQty)}</strong> 件。
              </Typography.Paragraph>
            )}
            {data.diffReasons.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.diffReasons.map(reason => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        </Space>
      )}
    </QueryBody>
  )
}

export function DispositionTab({ id }: { id: string }) {
  const query = useDetailQuery<InventoryDispositionResponse>(id, 'disposition')
  return (
    <QueryBody query={query}>
      {data => (
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <Card size="small" title="我方建议" data-testid="disposition-ours">
              <StateBlock state={data.ours.state} note={data.ours.state === 'OK' ? null : data.ours.note}>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="动作">{data.ours.action ? INVENTORY_ACTION_LABEL[data.ours.action] : '当前无需处置'}</Descriptions.Item>
                  <Descriptions.Item label="冗余 / 高龄数量">{qty(data.ours.excessQty)}</Descriptions.Item>
                  <Descriptions.Item label="预计节省">
                    {money(data.ours.estimatedSavings)} {data.ours.estimatedSavings === null ? null : <EstimateTag method={data.ours.note} />}
                  </Descriptions.Item>
                </Descriptions>
                {data.ours.formula ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {data.ours.formula}
                  </Typography.Text>
                ) : null}
                {data.ours.state === 'OK' ? (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {data.ours.note}
                    </Typography.Text>
                  </div>
                ) : null}
              </StateBlock>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="亚马逊建议" data-testid="disposition-amazon">
              <StateBlock state={data.amazon.state} note={data.amazon.note}>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="建议动作">{data.amazon.action ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="建议售价">{money(data.amazon.salePrice)}</Descriptions.Item>
                  <Descriptions.Item label="促销时长">{data.amazon.saleDays === null ? '—' : `${data.amazon.saleDays} 天`}</Descriptions.Item>
                  <Descriptions.Item label="建议移除数量">{qty(data.amazon.removalQty)}</Descriptions.Item>
                  <Descriptions.Item label="移除原因">{data.amazon.removalReason ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="预计节省（亚马逊口径）">{money(data.amazon.savings)}</Descriptions.Item>
                </Descriptions>
              </StateBlock>
            </Card>
          </Col>
        </Row>
      )}
    </QueryBody>
  )
}

type RuleEvents = { items: Array<{ id: string; occurredAt: string; title: string; actor: string }>; truncated: boolean }

/** 变更与审计：库存规则的版本变更（企业级，影响所有库存的判定）+ 这条库存记录的评论与关注。 */
export function AuditTab({ id }: { id: string }) {
  const events = useApiQuery<RuleEvents>({ domain: 'realtime', path: '/events', params: { entityType: 'REPLENISHMENT_POLICY', entityId: 'TENANT:ALL', limit: 20 }, scoped: false })
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={12}>
        <Card size="small" title="库存规则变更（对所有库存生效）">
          <QueryBody query={events}>
            {data =>
              data.items.length === 0 ? (
                <Muted>尚未配置过库存规则</Muted>
              ) : (
                <Timeline
                  items={data.items.map(item => ({
                    children: (
                      <>
                        <div>{item.title}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {item.actor} · {formatDateTime(item.occurredAt)}
                        </Typography.Text>
                      </>
                    ),
                  }))}
                />
              )
            }
          </QueryBody>
        </Card>
      </Col>
      <Col xs={24} md={12}>
        <Card size="small" title="评论与关注">
          <EntityCollaboration entityType="INVENTORY" entityId={id} />
        </Card>
      </Col>
    </Row>
  )
}
