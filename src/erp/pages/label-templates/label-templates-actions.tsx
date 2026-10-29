import { Space } from 'antd'
import { LABEL_TEMPLATE_MANAGE, type LabelTemplateRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { LabelTemplateFormItems, labelTemplateBody, labelTemplateDefaults, labelTemplateInitialValues, type LabelTemplateValues } from './label-templates-form'

// 标签模板的写操作（P6-12）：新增、修改、设为默认、删除。每个都走动作守卫（没有“标签模板维护”权限时按钮禁用并说明原因）；
// 结果以服务端为准：修改带着看到的版本号，别人先改过会提示刷新；同名、数量超限等服务端拒绝的原因如实显示。
// 删除模板不影响已经生成的文件与生成记录（记录里的模板引用置空）。

const guard = { permission: LABEL_TEMPLATE_MANAGE }

function useLabelTemplateWrites() {
  const create = useApiMutation<Record<string, unknown>, LabelTemplateRow>({ method: 'POST', path: '/label-templates', invalidate: ['list', 'reference'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, LabelTemplateRow>({
    method: 'PUT',
    path: variables => `/label-templates/${encodeURIComponent(variables.id)}`,
    body: variables => variables.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const remove = useApiMutation<string, { id: string }>({
    method: 'DELETE',
    path: id => `/label-templates/${encodeURIComponent(id)}`,
    body: () => undefined,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  return { create, update, remove }
}

export function CreateLabelTemplateAction({ onDone }: { onDone: () => void }) {
  const writes = useLabelTemplateWrites()
  return (
    <FormAction
      label="新增标签模板"
      guard={guard}
      title="新增标签模板"
      description="模板决定自定义箱标签上追加哪些文字、用什么纸张和怎样给箱子编号。亚马逊的标签本身不会被改动。"
      okText="保存"
      successText="已新增标签模板"
      width={640}
      buttonProps={{ type: 'primary' }}
      initialValues={labelTemplateDefaults() as Record<string, unknown>}
      onSubmit={values => writes.create.mutateAsync(labelTemplateBody(values as LabelTemplateValues))}
      onDone={onDone}
    >
      <LabelTemplateFormItems editing={false} />
    </FormAction>
  )
}

export function LabelTemplateRowActions({ row, onDone }: { row: LabelTemplateRow; onDone: () => void }) {
  const writes = useLabelTemplateWrites()
  return (
    <Space size={4}>
      <FormAction
        label="设为默认"
        guard={{ permission: LABEL_TEMPLATE_MANAGE, condition: { ok: !row.isDefault, reason: '已经是默认模板' } }}
        title={`把「${row.name}」设为默认模板`}
        description="生成自定义箱标签时不选模板就用默认模板；全企业只有一个默认，原来的默认会同时取消。"
        okText="设为默认"
        successText="已设为默认"
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.update.mutateAsync({ id: row.id, body: { version: row.version, ...labelTemplateBody(labelTemplateInitialValues(row)), isDefault: true } })}
        onDone={onDone}
      />
      <FormAction
        label="编辑"
        guard={guard}
        title={`编辑标签模板「${row.name}」`}
        description="修改只影响以后生成的标签；已经发起的任务用的是发起时的设置。"
        okText="保存修改"
        successText="已保存修改"
        width={640}
        buttonProps={{ size: 'small' }}
        initialValues={labelTemplateInitialValues(row) as Record<string, unknown>}
        onSubmit={values => writes.update.mutateAsync({ id: row.id, body: { version: row.version, ...labelTemplateBody(values as LabelTemplateValues) } })}
        onDone={onDone}
      >
        <LabelTemplateFormItems editing />
      </FormAction>
      <FormAction
        label="删除"
        guard={guard}
        title={`删除标签模板「${row.name}」`}
        description={row.isDefault ? '这是默认模板：删除后不选模板时改用系统内置的默认设置。已经生成的文件和生成记录不受影响。' : '删除后不能恢复。已经生成的文件和生成记录不受影响。'}
        okText="删除"
        successText="已删除"
        danger
        buttonProps={{ size: 'small' }}
        onSubmit={() => writes.remove.mutateAsync(row.id)}
        onDone={onDone}
      />
    </Space>
  )
}
