import { App, Button, Card, Descriptions, Steps, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CASE_STEPS, REIMBURSEMENTS_WRITE, caseStepOf, type CaseDetailResponse, type EvidencePackRow, type MatchedRecordRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { money, text, timeText } from '../orders/orders-ui'
import { AttachmentsPanel } from '../procurement/procurement-ui'
import { SupportLinkInfo } from '../support/support-ui'
import { amountOr, dayText, receivedText } from './reimbursements-ui'
import { openSignedUrl } from '../../security/safe-url'

// 案件详情的各个页签：概览（进度、识别依据、证据引用）、证据与附件（附件上传、证据包）、官方赔付匹配。
// 没有数据写“尚无记录”，没有回填的亚马逊案件编号写“尚未回填”，没有匹配到赔付写“尚无到账”，都不写 0。

export function Overview({ detail }: { detail: CaseDetailResponse }) {
  const row = detail.case
  const step = caseStepOf(row.status)
  return (
    <div>
      <Steps
        size="small"
        current={step.current}
        status={step.failed ? 'error' : 'process'}
        items={CASE_STEPS.map((title, index) => ({ title: index === 3 && step.failed ? '已拒绝' : title }))}
        style={{ marginBottom: 16 }}
      />
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered data-testid="case-overview">
        <Descriptions.Item label="案件编号">{row.caseNo}</Descriptions.Item>
        <Descriptions.Item label="亚马逊案件编号">{row.amazonCaseId ?? <Muted>尚未回填</Muted>}</Descriptions.Item>
        <Descriptions.Item label="机会类型">{row.ruleLabel}</Descriptions.Item>
        <Descriptions.Item label="店铺">{row.storeName}</Descriptions.Item>
        <Descriptions.Item label="SKU / 数量">{row.sku ? `${row.sku}${row.qty === null ? '' : ` × ${row.qty}`}` : <Muted>尚无记录</Muted>}</Descriptions.Item>
        <Descriptions.Item label="负责人">{row.ownerName}</Descriptions.Item>
        <Descriptions.Item label="提交时间">{timeText(row.submittedAt)}</Descriptions.Item>
        <Descriptions.Item label="亚马逊结论时间">{timeText(row.decidedAt)}</Descriptions.Item>
        <Descriptions.Item label="第一笔到账">{timeText(row.paidAt)}</Descriptions.Item>
        <Descriptions.Item label="申请截止">{dayText(row.deadlineAt)}</Descriptions.Item>
        <Descriptions.Item label="备注" span={2}>
          {text(row.note)}
        </Descriptions.Item>
        <Descriptions.Item label="识别依据" span={2}>
          {detail.basis}
        </Descriptions.Item>
        <Descriptions.Item label="证据引用" span={2}>
          {detail.evidence.length ? detail.evidence.map(item => <div key={`${item.kind}|${item.id}`}>{item.label}</div>) : <Muted>尚无记录</Muted>}
        </Descriptions.Item>
        <Descriptions.Item label="亚马逊支持案件" span={2}>
          <SupportLinkInfo view={detail.supportCases} />
        </Descriptions.Item>
      </Descriptions>
    </div>
  )
}

function DownloadPack({ pack }: { pack: EvidencePackRow }) {
  const { message } = App.useApp()
  return (
    <Button
      type="link"
      size="small"
      disabled={!pack.downloadable || !pack.exportJobId}
      onClick={async () => {
        try {
          const link = await apiFetch<{ url: string }>(`/exports/${encodeURIComponent(pack.exportJobId ?? '')}/download`)
          openSignedUrl(link.url)
        } catch (error) {
          void message.error(describeError(error).message)
        }
      }}
    >
      下载
    </Button>
  )
}

const packColumns: ColumnsType<EvidencePackRow> = [
  { title: '生成时间', dataIndex: 'generatedAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '生成人', dataIndex: 'generatedBy', width: 140 },
  { title: '清单行数', dataIndex: 'lineCount', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '文件状态', dataIndex: 'exportStatusLabel', width: 120, render: (value: string | null) => value ?? <Muted>导出任务已不存在</Muted> },
  { title: '操作', key: 'op', width: 90, render: (_value, row) => <DownloadPack pack={row} /> },
]

export function EvidenceTab({ detail, onChanged }: { detail: CaseDetailResponse; onChanged: () => void }) {
  return (
    <div>
      <Card size="small" title="证据附件" style={{ marginBottom: 12 }}>
        <Typography.Paragraph type="secondary">装箱单、签收证明、库存调整截图、退货记录等材料。附件不会自动并入证据包，提交亚马逊时请连同证据包一起上传。</Typography.Paragraph>
        <AttachmentsPanel base={`/reimbursements/${encodeURIComponent(detail.case.id)}`} items={detail.attachments} writePermission={REIMBURSEMENTS_WRITE} onChanged={onChanged} />
      </Card>
      <Card size="small" title="证据包">
        <SimpleGrid<EvidencePackRow>
          gridId="reimbursements.case-tabs"
          columns={packColumns}
          rows={detail.packs}
          rowKey={row => row.id}
          emptyState={{ kind: 'empty', domain: '证据包', prerequisite: '还没有生成过证据包；点页面上方的“生成证据包”，会把案件信息、识别依据、证据与附件清单固化成一份可下载的文件。' }}
        />
      </Card>
    </div>
  )
}

const recordColumns: ColumnsType<MatchedRecordRow> = [
  { title: '赔付编号', dataIndex: 'reimbursementId', width: 150 },
  { title: 'SKU', dataIndex: 'sku', width: 150 },
  { title: '赔付原因', dataIndex: 'reason', render: (value: string) => value || <Muted>亚马逊未提供</Muted> },
  { title: '数量', dataIndex: 'quantity', width: 80, align: 'right', render: (value: number) => <span className="erp-num">{value}</span> },
  { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (value: number, row) => money(value, row.currency) },
  { title: '批准日', dataIndex: 'approvedAt', width: 110, render: dayText },
  { title: '匹配依据', dataIndex: 'matchBasisLabel', width: 190 },
]

export function RecordsTab({ detail }: { detail: CaseDetailResponse }) {
  const row = detail.case
  return (
    <div>
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ marginBottom: 12 }} data-testid="case-amounts">
        <Descriptions.Item label="应收">{amountOr(row.expectedAmount, row.currency, '尚未填写')}</Descriptions.Item>
        <Descriptions.Item label="亚马逊批准">{amountOr(row.approvedAmount, row.currency, '尚无记录')}</Descriptions.Item>
        <Descriptions.Item label="实收（赔付明细合计）">{receivedText(row.receivedAmount, row.currency)}</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary">
        实收只来自官方赔付明细（赔付报告，每天同步）的自动匹配，不能手填。匹配顺序：亚马逊案件编号一致 → 订单号与 SKU 一致 → SKU 与赔付原因吻合；候选不唯一时不猜，明细会留在“未归属赔付”。
      </Typography.Paragraph>
      <SimpleGrid<MatchedRecordRow>
        gridId="reimbursements.case-tabs-2"
        columns={recordColumns}
        rows={detail.records}
        rowKey={item => item.id}
        emptyState={{ kind: 'empty', domain: '官方赔付明细', prerequisite: '还没有匹配到官方赔付明细。案件提交并回填亚马逊案件编号后，赔付报告同步到的赔付会自动匹配到这里。' }}
      />
      <AppLink to="/app/reimbursements">返回赔付中心</AppLink>
    </div>
  )
}
