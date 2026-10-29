import { Form, Input, Select, Space } from 'antd'
import { RETURN_REASON_CATEGORIES, RETURN_REASON_MAP_WRITE, type ReturnReasonMapPutResponse, type ReturnReasonMapRow } from '@nova/api-contracts'
import { FormAction } from '../../components'
import { useApiMutation } from '../../query/api-query'

// 原因映射的写操作（P6-13）：新增原因、修改中文释义与大类、把改过的预置项恢复成出厂值。
// 都走动作守卫（没有“企业设置”修改权限时按钮禁用并说明原因）；一次保存一行，写审计；结果以服务端为准。
// 修改只影响以后的显示与汇总，不改退货记录本身（记录里存的是亚马逊的原始原因代码）。

const guard = { permission: RETURN_REASON_MAP_WRITE }
const categoryOptions = RETURN_REASON_CATEGORIES.map(value => ({ value, label: value }))

type Item = { code: string; labelZh: string; category: string }

function useReasonMapWrite() {
  return useApiMutation<Item, ReturnReasonMapPutResponse>({
    method: 'PUT',
    path: '/returns/reason-map',
    body: item => ({ items: [item] }),
    invalidate: ['list', 'analytics'],
    silent: true,
  })
}

// 表单字段名不能叫 code：动作表单把 code 当作再次验证身份的验证码，提交前会从请求里删掉。
function ReasonFormItems({ editing }: { editing: boolean }) {
  return (
    <>
      <Form.Item
        label="原因代码"
        name="reasonCode"
        rules={[{ required: true, whitespace: true, message: '请填写原因代码' }]}
        extra={editing ? '原因代码是亚马逊报告里的原值，不能修改。' : '填亚马逊报告里的原因代码，例如 DEFECTIVE（不分大小写）。'}
      >
        <Input disabled={editing} maxLength={80} />
      </Form.Item>
      <Form.Item label="中文释义" name="labelZh" rules={[{ required: true, whitespace: true, message: '请填写中文释义' }]}>
        <Input maxLength={60} />
      </Form.Item>
      <Form.Item label="大类" name="category" rules={[{ required: true, message: '请选择大类' }]} extra="大类只能从列表里选，保证汇总口径稳定；选“未分类”表示还没想好。">
        <Select options={categoryOptions} aria-label="大类" />
      </Form.Item>
    </>
  )
}

const itemOf = (values: Record<string, unknown>): Item => ({ code: String(values.reasonCode ?? '').trim(), labelZh: String(values.labelZh ?? '').trim(), category: String(values.category ?? '') })

export function CreateReasonAction({ onDone }: { onDone: () => void }) {
  const write = useReasonMapWrite()
  return (
    <FormAction
      label="新增原因"
      guard={guard}
      title="新增退货原因"
      description="亚马逊报告里出现了映射表没有的原因代码时，在这里补上中文释义和大类。新增后，退货列表和退货分析里的这个代码会按这里的设置显示。"
      okText="保存"
      successText="已新增退货原因"
      buttonProps={{ type: 'primary' }}
      initialValues={{ reasonCode: '', labelZh: '', category: '其他原因' }}
      onSubmit={values => write.mutateAsync(itemOf(values))}
      onDone={onDone}
    >
      <ReasonFormItems editing={false} />
    </FormAction>
  )
}

export function ReasonRowActions({ row, onDone }: { row: ReturnReasonMapRow; onDone: () => void }) {
  const write = useReasonMapWrite()
  const restorable = row.source === 'PRESET_EDITED' && row.presetLabelZh !== null && row.presetCategory !== null
  return (
    <Space size={4}>
      <FormAction
        label="编辑"
        guard={guard}
        title={`编辑退货原因 ${row.code}`}
        description="只改显示与汇总的口径，不改退货记录里亚马逊的原始原因代码。"
        okText="保存修改"
        successText="已保存修改"
        buttonProps={{ size: 'small' }}
        initialValues={{ reasonCode: row.code, labelZh: row.labelZh, category: row.category }}
        onSubmit={values => write.mutateAsync({ ...itemOf(values), code: row.code })}
        onDone={onDone}
      >
        <ReasonFormItems editing />
      </FormAction>
      {restorable ? (
        <FormAction
          label="恢复预置"
          guard={guard}
          title={`把 ${row.code} 恢复成预置的释义与大类`}
          description={`恢复后显示为「${row.presetLabelZh}」，大类「${row.presetCategory}」。`}
          okText="恢复"
          successText="已恢复预置"
          buttonProps={{ size: 'small' }}
          onSubmit={() => write.mutateAsync({ code: row.code, labelZh: row.presetLabelZh ?? row.labelZh, category: row.presetCategory ?? row.category })}
          onDone={onDone}
        />
      ) : null}
    </Space>
  )
}
