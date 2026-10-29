import { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { boxDraftIssues, boxDraftTotals, boxDraftsToInputs, type BoxDraft, type InboundBoxesResponse, type InboundOverview } from '@nova/api-contracts'
import { ActionGuard, PagedGrid, type PageFetcher } from '../../../components'
import { usePlanWrite, versionOf } from '../inbound-actions'
import { BoxImportAction } from '../inbound-option-actions'
import { inboundGuard } from '../inbound-ui'
import { BoxEditDrawer } from './BoxEditDrawer'
import { BoxFileImportAction } from './BoxFileImport'
import { boxEditorColumns } from './box-editor-columns'
import { boxGridRows, type BoxGridRow } from './box-grid-rows'
import { BoxSpecsButton } from './BoxSpecsButton'
import { BoxTotals } from './BoxTotals'
import { useBoxDraft } from './use-box-draft'

// 装箱可视编辑器（P6-10，15 章第 5.4 节）：每箱一行、箱内商品是子行；加箱、复制箱、删箱、批量设箱规；底部实时合计。
// 修改只在浏览器里，点“保存草稿”先在本地校验，通过后带版本号保存；提交给亚马逊时服务端仍做整份校验与数量核对。
// 箱子可编辑的时机由服务端给出（overview.actions.SAVE_BOXES），不可编辑时只读并写明原因。

const ISSUES_SHOWN = 5

function Editor({ overview, data }: { overview: InboundOverview; data: InboundBoxesResponse }) {
  const write = usePlanWrite(overview.plan.id)
  const state = overview.actions.SAVE_BOXES
  const editable = state.allowed
  const planSkus = useMemo(() => overview.items.map(item => item.sku), [overview.items])
  const skuSet = useMemo(() => new Set(planSkus), [planSkus])
  const sourceKey = `${overview.plan.version}|${JSON.stringify(data.boxes)}`
  const draft = useBoxDraft(data.boxes, sourceKey)
  const [editing, setEditing] = useState<BoxDraft | null>(null)

  const totals = useMemo(() => boxDraftTotals(draft.boxes, overview.items), [draft.boxes, overview.items])
  const issues = useMemo(() => boxDraftIssues(draft.boxes, overview.items), [draft.boxes, overview.items])
  const rows = useMemo(() => boxGridRows(draft.boxes, skuSet), [draft.boxes, skuSet])

  const { boxes, copy, remove } = draft
  const rowActions = useCallback(
    (row: BoxGridRow) => (
      <>
        <Button size="small" type="link" onClick={() => setEditing(boxes.find(box => box.key === row.boxKey) ?? null)}>
          编辑
        </Button>
        <Button size="small" type="link" onClick={() => copy(row.boxKey)}>
          复制
        </Button>
        <Popconfirm title={`删除箱子 ${row.name}？`} okText="删除" cancelText="取消" onConfirm={() => remove(row.boxKey)}>
          <Button size="small" type="link" danger>
            删除
          </Button>
        </Popconfirm>
      </>
    ),
    [boxes, copy, remove],
  )
  const columns = useMemo(() => boxEditorColumns(rowActions, editable), [rowActions, editable])
  const fetchPage = useCallback<PageFetcher<BoxGridRow>>(async ({ page, pageSize }) => ({ items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length }), [rows])

  const saveGuard = inboundGuard(undefined, {
    amazon: false,
    condition: !editable
      ? { ok: false, reason: state.reason ?? '现在不能修改箱内物品' }
      : !draft.dirty
        ? { ok: false, reason: '没有未保存的修改' }
        : issues.length > 0
          ? { ok: false, reason: `有 ${issues.length} 处要先改：${issues[0]}` }
          : { ok: true },
  })

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {editable ? null : <Alert type="info" showIcon message="现在不能修改箱内物品" description={state.reason ?? undefined} />}
      {draft.dirty ? (
        <Alert
          type={issues.length > 0 ? 'warning' : 'info'}
          showIcon
          message={issues.length > 0 ? `有未保存的修改，保存前要先改 ${issues.length} 处` : '有未保存的修改，点“保存草稿”后才会保存'}
          description={issues.length > 0 ? issues.slice(0, ISSUES_SHOWN).join('；') + (issues.length > ISSUES_SHOWN ? `；还有 ${issues.length - ISSUES_SHOWN} 处` : '') : undefined}
        />
      ) : data.validation.ok ? (
        <Alert type="success" showIcon message="每个 SKU 的装箱总数与计划一致，可以提交" />
      ) : data.boxes.length === 0 ? (
        <Alert type="info" showIcon message="还没有填写箱内物品" description="装箱方案确认后，可以在这里添加箱子，或用表格文件、粘贴文本导入；每个 SKU 的装箱总数必须等于计划数量才能提交。" />
      ) : (
        <Alert type="warning" showIcon message="箱内物品与计划不一致，不能提交" description={data.validation.problems.slice(0, 10).join('；')} />
      )}
      {editable ? (
        <Space wrap>
          <Button onClick={draft.add}>添加箱子</Button>
          <ActionGuard
            label="保存草稿"
            guard={saveGuard}
            buttonProps={{ type: 'primary' }}
            successText="已保存箱内物品"
            onExecute={() => write.put('/boxes', { ...versionOf(overview.plan), boxes: boxDraftsToInputs(draft.boxes) })}
            onDone={draft.saved}
          />
          <Button disabled={!draft.dirty} onClick={draft.discard}>
            放弃修改
          </Button>
          <BoxFileImportAction overview={overview} />
          <BoxImportAction overview={overview} />
        </Space>
      ) : null}
      <PagedGrid<BoxGridRow>
        gridId="inbound.boxes"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={String(draft.revision)}
        initialPageSize={200}
        tree={{ hasChildren: row => row.kind === 'box' && (row.children?.length ?? 0) > 0, getChildren: row => row.children }}
        renderBulkActions={
          editable
            ? selected => {
                const keys = new Set(selected.filter(row => row.kind === 'box').map(row => row.boxKey))
                return <BoxSpecsButton count={keys.size} onApply={specs => draft.setSpecs(keys, specs)} />
              }
            : undefined
        }
        emptyState={{ kind: 'empty', domain: '箱内物品', prerequisite: editable ? '还没有箱子。点“添加箱子”，或用表格文件、粘贴文本导入。' : '还没有填写箱内物品。' }}
        height={360}
      />
      <BoxTotals totals={totals} />
      {editing ? (
        <BoxEditDrawer
          key={editing.key}
          box={editing}
          planSkus={planSkus}
          onClose={() => setEditing(null)}
          onSave={next => {
            draft.replace(next)
            setEditing(null)
          }}
        />
      ) : null}
    </Space>
  )
}

export function BoxEditor(props: { overview: InboundOverview; data: InboundBoxesResponse }) {
  // 同一个计划的编辑状态跟着计划走，换计划时整体重建
  return <Editor key={props.overview.plan.id} {...props} />
}
