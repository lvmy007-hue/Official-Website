import { useState } from 'react'
import { Alert, Input, Modal, Typography } from 'antd'
import { APLUS_LIMITS, type AplusWriteResult } from '@nova/api-contracts'
import { useAssociateAsins, useSubmitAplus, writeErrorText } from './aplus-api'
import { parseAsinInput } from './aplus-format'

// 关联 ASIN 与提交审核的两个弹窗（P4-14）。都只代表“已登记”，结果在写入记录里看。

type Done = (result: AplusWriteResult) => void

/** 关联 ASIN：空格、逗号、换行都可以分隔；大写规整、去重；本地校验 10 位字母数字与个数上限，通过后才发请求（追加，不删除已有的）。 */
export function AssociateModal({ open, id, version, onClose, onDone }: { open: boolean; id: string; version: number; onClose: () => void; onDone: Done }) {
  const [text, setText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const associate = useAssociateAsins()
  const parsed = parseAsinInput(text)
  const blocked = parsed.asins.length === 0 || parsed.issues.length > 0

  const submit = async () => {
    setFailure(null)
    try {
      const result = await associate.mutateAsync({ id, version, asins: parsed.asins })
      setText('')
      onDone(result)
    } catch (error) {
      setFailure(writeErrorText(error))
    }
  }

  return (
    <Modal
      open={open}
      title="关联 ASIN"
      okText="提交关联"
      cancelText="取消"
      maskClosable={false}
      afterClose={() => setFailure(null)}
      okButtonProps={{ disabled: blocked, loading: associate.isPending }}
      onOk={() => void submit()}
      onCancel={() => (associate.isPending ? undefined : onClose())}
    >
      <Typography.Paragraph type="secondary">
        可以一次填多个，用空格、逗号或换行分隔；一次最多 {APLUS_LIMITS.asinsPerRequestMax} 个。这里只追加关联，不会取消已有的关联。内容必须与每个关联的商品相符。
      </Typography.Paragraph>
      <Input.TextArea aria-label="ASIN 列表" rows={5} value={text} placeholder="B0ABCDE123, B0ABCDE124" onChange={event => setText(event.target.value)} />
      <div data-testid="aplus-asin-summary" style={{ marginTop: 8 }}>
        {text.trim() === '' ? '还没有填写' : `将关联 ${parsed.asins.length} 个 ASIN${parsed.duplicates > 0 ? `（已去掉 ${parsed.duplicates} 个重复的）` : ''}`}
      </div>
      {parsed.issues.map(issue => (
        <Typography.Text key={issue} type="danger" role="alert" style={{ display: 'block' }}>
          {issue}
        </Typography.Text>
      ))}
      {failure ? <Alert style={{ marginTop: 8 }} type="error" showIcon role="alert" message={failure} /> : null}
    </Modal>
  )
}

/** 提交审核：二次确认，说明审核期间不能修改。 */
export function SubmitModal({ open, id, version, onClose, onDone }: { open: boolean; id: string; version: number; onClose: () => void; onDone: Done }) {
  const [failure, setFailure] = useState<string | null>(null)
  const submit = useSubmitAplus()

  const run = async () => {
    setFailure(null)
    try {
      onDone(await submit.mutateAsync({ id, version }))
    } catch (error) {
      setFailure(writeErrorText(error))
    }
  }

  return (
    <Modal
      open={open}
      title="确认提交审核"
      okText="确认提交"
      cancelText="取消"
      maskClosable={false}
      afterClose={() => setFailure(null)}
      okButtonProps={{ loading: submit.isPending }}
      onOk={() => void run()}
      onCancel={() => (submit.isPending ? undefined : onClose())}
    >
      <p style={{ fontWeight: 600 }}>提交后审核期间不能修改内容，也不能修改关联的 ASIN。</p>
      <p style={{ margin: 0 }}>审核由亚马逊进行，通过或被拒的结果会在下一次同步后更新到状态与时间线里；提交本身先登记，再由后台任务发给亚马逊。</p>
      {failure ? <Alert style={{ marginTop: 8 }} type="error" showIcon role="alert" message={failure} /> : null}
    </Modal>
  )
}
