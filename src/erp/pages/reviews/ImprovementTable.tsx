import { Alert, Form, Input, Select, Typography } from 'antd'
import { REVIEWS_LIMITS, type ImprovementRow, type ReturnsTabResponse } from '@nova/api-contracts'
import { FormAction, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { improvementColumns } from './reviews-columns'
import { SEVERITY_LABEL, improvementAction, improvementDetail, improvementTitle, type Severity } from './reviews-state'
import { Muted, SectionNote } from './reviews-ui'

// 产品改进清单（P4-13）：把商品最新的负面评论主题与近 90 天的退货原因放在一起，按退货件数排序；“可能相关”只是文字比对，不代表因果。
// “指派跟进”生成一条待办（POST /work-items，需要 workitem.assign）：选负责人需要 member.read，没有该权限只能指派给自己；严重度默认“提示”，截止日期可空。

type Member = { status: string; user: { id: string; displayName: string; email: string } }
type Improvements = ReturnsTabResponse['improvements']

const SEVERITIES = Object.keys(SEVERITY_LABEL) as Severity[]

function AssignAction({
  row,
  days,
  owners,
  canPick,
  onCreate,
  selfId,
}: {
  row: ImprovementRow
  days: number
  owners: Array<{ value: string; label: string }>
  canPick: boolean
  selfId: string
  onCreate: (body: Record<string, unknown>) => Promise<unknown>
}) {
  return (
    <FormAction
      label="指派跟进"
      title={`指派跟进：${row.asin}`}
      okText="生成待办"
      successText="已生成待办"
      guard={{ permission: 'workitem.assign' }}
      buttonProps={{ type: 'link', size: 'small' }}
      description={
        <>
          <p style={{ margin: 0 }}>将生成一条待办：{improvementTitle(row)}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{row.suggestion}</p>
        </>
      }
      initialValues={{ ownerId: selfId, severity: 'INFO' }}
      onSubmit={async values => {
        const dueDate = typeof values.dueDate === 'string' ? values.dueDate : ''
        await onCreate({
          title: improvementTitle(row),
          detail: improvementDetail(row, days),
          severity: values.severity,
          ownerId: canPick ? values.ownerId : selfId,
          entityLabel: row.asin,
          suggestedAction: improvementAction(row),
          ...(dueDate ? { dueAt: new Date(`${dueDate}T23:59:59`).toISOString() } : {}),
        })
      }}
    >
      <Form.Item
        label="负责人"
        name="ownerId"
        rules={[{ required: true, message: '请选择负责人' }]}
        extra={canPick ? undefined : '选择其他负责人需要“成员查看”权限（member.read），当前只能指派给自己'}
      >
        <Select aria-label="负责人" disabled={!canPick} virtual={false} showSearch optionFilterProp="label" options={owners} />
      </Form.Item>
      <Form.Item label="严重度" name="severity" rules={[{ required: true, message: '请选择严重度' }]}>
        <Select aria-label="严重度" virtual={false} options={SEVERITIES.map(value => ({ value, label: SEVERITY_LABEL[value] }))} />
      </Form.Item>
      <Form.Item label="截止日期（可空）" name="dueDate">
        <Input type="date" aria-label="截止日期" min={new Date().toISOString().slice(0, 10)} style={{ width: 200 }} />
      </Form.Item>
    </FormAction>
  )
}

export function ImprovementTable({ improvements }: { improvements: Improvements }) {
  const { me, canPermission } = useSession()
  const canPick = canPermission('member.read')
  const members = useApiQuery<Member[]>({ domain: 'reference', path: '/members/options', scoped: false, enabled: canPick && improvements.rows.length > 0 })
  const create = useApiMutation<Record<string, unknown>, unknown>({ method: 'POST', path: '/work-items', invalidate: ['realtime'], silent: true })
  const selfLabel = `${me.user.displayName || me.user.email}（我）`
  const others = (members.data ?? []).filter(member => member.status === 'ACTIVE' && member.user.id !== me.user.id)
  const owners = [{ value: me.user.id, label: selfLabel }, ...(canPick ? others.map(member => ({ value: member.user.id, label: member.user.displayName || member.user.email })) : [])]

  if (improvements.state === 'RESTRICTED') {
    return <Alert type="warning" showIcon message="无权限（需要退货查看权限）" description={improvements.note ?? undefined} />
  }
  if (improvements.state !== 'OK') return <SectionNote state={improvements.state} note={improvements.note} />

  return (
    <div data-testid="improvement-table">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        负面评论主题取商品最新一次同步（最多 3 个），退货取近 {improvements.days} 天，按退货件数排序；“可能相关”只是文字上有重合，不代表因果。
      </Typography.Paragraph>
      <SimpleGrid<ImprovementRow>
        gridId="reviews.improvement-table"
        columns={improvementColumns(
          row => (
            <AssignAction row={row} days={improvements.days} owners={owners} canPick={canPick} selfId={me.user.id} onCreate={body => create.mutateAsync(body)} />
          ),
          improvements.days,
        )}
        rows={improvements.rows}
        rowKey={row => `${row.storeId}|${row.asin}`}
        emptyState={{ kind: 'empty', domain: '产品改进清单', prerequisite: improvements.note ?? '没有同时具备负面评论主题与退货记录的商品；同步评论主题与退货报告后显示。' }}
      />
      {improvements.rows.length === 0 ? null : (
        <Muted>
          共 {improvements.rows.length} 个商品（最多列出 {REVIEWS_LIMITS.improvementsMax} 个）。
        </Muted>
      )}
    </div>
  )
}
