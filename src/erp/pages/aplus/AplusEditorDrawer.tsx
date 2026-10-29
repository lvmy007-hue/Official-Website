import { useState } from 'react'
import { Alert, Button, Card, Drawer, Input, Select, Space, Typography } from 'antd'
import {
  APLUS_LIMITS,
  APLUS_MODULE_DEFS,
  APLUS_MODULE_TYPES,
  aplusEmptyModule,
  type AplusFormModule,
  type AplusModuleType,
  type AplusStoreRef,
  type AplusUploadsResponse,
  type AplusWriteResult,
} from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'
import { useCreateAplus, useUpdateAplus, writeErrorText } from './aplus-api'
import { editorIssues } from './aplus-format'
import { ModuleForm, moduleTitle } from './AplusModuleForms'

// A+ 内容的结构化编辑器（P4-14）：新建与编辑共用。选店铺（仅新建）、填名称、添加/删除/上下移模块、按模块类型填表单；
// 图片从“图片库”里选；提交前先做本地校验并逐条显示问题；提交只代表“已登记”，结果在详情页的写入记录里看。

export interface EditorInitial {
  /** 编辑时有：内容编号与受理时的版本号（保存要带它）。 */
  id?: string
  version?: number
  storeId: string
  storeName: string
  name: string
  modules: AplusFormModule[]
}

export interface EditorDrawerProps {
  open: boolean
  stores: readonly AplusStoreRef[]
  /** 不传是新建；传了是编辑（店铺不能改）。 */
  initial?: EditorInitial
  onClose: () => void
  onDone: (result: AplusWriteResult, mode: 'create' | 'edit') => void
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function EditorBody({ stores, initial, onClose, onDone }: Omit<EditorDrawerProps, 'open'>) {
  const editing = Boolean(initial?.id)
  const [storeId, setStoreId] = useState<string | undefined>(initial?.storeId ?? (stores.length === 1 ? stores[0].id : undefined))
  const [name, setName] = useState(initial?.name ?? '')
  const [modules, setModules] = useState<AplusFormModule[]>(initial?.modules ?? [])
  const [adding, setAdding] = useState<AplusModuleType>('STANDARD_TEXT')
  const [issues, setIssues] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const create = useCreateAplus()
  const update = useUpdateAplus()
  const busy = create.isPending || update.isPending

  const uploads = useApiQuery<AplusUploadsResponse>({ domain: 'list', path: '/aplus/uploads', scoped: false, params: { storeId }, enabled: Boolean(storeId) })
  const ready = uploads.data?.items ?? []
  const change = (index: number, next: AplusFormModule) => setModules(list => list.map((item, i) => (i === index ? next : item)))

  const submit = async () => {
    const found = editorIssues({ storeId, name, modules, needStore: !editing })
    setIssues(found)
    setFailure(null)
    if (found.length > 0 || !storeId) return
    try {
      if (initial?.id) onDone(await update.mutateAsync({ id: initial.id, version: initial.version ?? 0, name: name.trim(), modules }), 'edit')
      else onDone(await create.mutateAsync({ storeId, name: name.trim(), modules }), 'create')
    } catch (error) {
      setFailure(writeErrorText(error))
    }
  }

  return (
    <>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {editing ? (
          <div>
            店铺：<strong>{initial?.storeName}</strong>
          </div>
        ) : (
          <Select
            virtual={false}
            style={{ width: 280 }}
            placeholder="选择店铺"
            aria-label="所属店铺"
            value={storeId}
            options={stores.map(store => ({ value: store.id, label: store.name }))}
            onChange={value => {
              setStoreId(value)
              // 换店铺后图片库不同，已选的图片失效，清掉
              setModules(list => list.map(item => withoutImages(item)))
            }}
          />
        )}
        <div>
          <Input aria-label="内容名称" placeholder="内容名称（只在系统里显示，最多 100 个字符）" value={name} onChange={event => setName(event.target.value)} />
          <div style={{ fontSize: 12, textAlign: 'right', color: name.length > APLUS_LIMITS.nameMax ? '#cf1322' : 'rgba(0,0,0,0.45)' }}>
            {name.length}/{APLUS_LIMITS.nameMax}
          </div>
        </div>
        {uploads.isError ? <Alert type="warning" showIcon message="读取图片库失败，暂时不能选择图片；请稍后重新打开编辑器" /> : null}
        {modules.map((module, index) => (
          <Card
            key={index}
            size="small"
            data-testid={`aplus-module-${index + 1}`}
            title={`模块 ${index + 1} · ${moduleTitle(module.type)}`}
            extra={
              <Space size={4}>
                <Button size="small" disabled={index === 0} aria-label={`模块 ${index + 1} 上移`} onClick={() => setModules(list => move(list, index, index - 1))}>
                  上移
                </Button>
                <Button size="small" disabled={index === modules.length - 1} aria-label={`模块 ${index + 1} 下移`} onClick={() => setModules(list => move(list, index, index + 1))}>
                  下移
                </Button>
                <Button size="small" danger aria-label={`模块 ${index + 1} 删除`} onClick={() => setModules(list => list.filter((_item, i) => i !== index))}>
                  删除
                </Button>
              </Space>
            }
          >
            <ModuleForm module={module} n={index + 1} uploads={ready} onChange={next => change(index, next)} />
          </Card>
        ))}
        <Space wrap>
          <Select
            virtual={false}
            style={{ width: 280 }}
            aria-label="模块类型"
            value={adding}
            options={APLUS_MODULE_TYPES.map(type => ({ value: type, label: `${APLUS_MODULE_DEFS[type].label}：${APLUS_MODULE_DEFS[type].description}` }))}
            onChange={setAdding}
          />
          <Button disabled={modules.length >= APLUS_LIMITS.modulesMax} onClick={() => setModules(list => [...list, aplusEmptyModule(adding)])}>
            添加模块
          </Button>
          <Typography.Text type="secondary">
            已添加 {modules.length}/{APLUS_LIMITS.modulesMax} 个模块；亚马逊对内容有自己的规定，以审核结果为准
          </Typography.Text>
        </Space>
        {issues.length > 0 ? (
          <Alert
            data-testid="aplus-editor-issues"
            type="error"
            showIcon
            message={`还有 ${issues.length} 个问题要先改正`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            }
          />
        ) : null}
        {failure ? <Alert data-testid="aplus-editor-failure" type="error" showIcon role="alert" message={failure} /> : null}
      </Space>
      <Space style={{ marginTop: 16 }}>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button type="primary" loading={busy} onClick={() => void submit()}>
          {editing ? '保存修改' : '创建内容'}
        </Button>
      </Space>
    </>
  )
}

/** 换店铺：文字保留，图片清空（图片库是按店铺的）。 */
function withoutImages(module: AplusFormModule): AplusFormModule {
  switch (module.type) {
    case 'STANDARD_TEXT':
    case 'STANDARD_PRODUCT_DESCRIPTION':
      return module
    case 'STANDARD_COMPANY_LOGO':
      return { ...module, image: null }
    case 'STANDARD_HEADER_IMAGE_TEXT':
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return { ...module, block: { ...module.block, image: null } }
    case 'STANDARD_THREE_IMAGE_TEXT':
      return { ...module, blocks: module.blocks.map(block => ({ ...block, image: null })) as typeof module.blocks }
  }
}

export function AplusEditorDrawer({ open, stores, initial, onClose, onDone }: EditorDrawerProps) {
  return (
    <Drawer
      open={open}
      width={720}
      title={initial?.id ? '编辑 A+ 内容' : '新建 A+ 内容'}
      destroyOnClose
      maskClosable={false}
      onClose={onClose}
      extra={<Typography.Text type="secondary">提交后先登记，再由后台任务发给亚马逊</Typography.Text>}
    >
      {open ? <EditorBody stores={stores} initial={initial} onClose={onClose} onDone={onDone} /> : null}
    </Drawer>
  )
}
