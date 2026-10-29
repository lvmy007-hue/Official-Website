import { Input, Radio, Select, Typography } from 'antd'
import { APLUS_MODULE_DEFS, APLUS_TEXT_LIMITS, type AplusFormModule, type AplusImage, type AplusImageBlock, type AplusModuleType, type AplusUploadRow } from '@nova/api-contracts'
import { imageOptionState, imageSizeText } from './aplus-format'

// 各种模块的表单（P4-14）：纯受控组件，数据都在编辑器抽屉里。
// 文字带字数提示；图片模块从“图片库”里选（该店铺已上传成功的图），并提示模块要求的尺寸，尺寸不够的图禁用并说明原因。

type Change = (module: AplusFormModule) => void

function Counter({ value, max }: { value: string; max: number }) {
  const over = value.length > max
  return (
    <div style={{ fontSize: 12, color: over ? '#cf1322' : 'rgba(0,0,0,0.45)', textAlign: 'right' }}>
      {value.length}/{max}
      {over ? '（超出上限）' : ''}
    </div>
  )
}

function TextField({ label, value, max, rows, onChange }: { label: string; value: string; max: number; rows?: number; onChange: (value: string) => void }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 2 }}>{label}</div>
      {rows ? (
        <Input.TextArea aria-label={label} rows={rows} value={value} onChange={event => onChange(event.target.value)} />
      ) : (
        <Input aria-label={label} value={value} onChange={event => onChange(event.target.value)} />
      )}
      <Counter value={value} max={max} />
    </div>
  )
}

/** 图片：从图片库选，写替代文字；已有内容里的图片不在图片库时也保留（只显示编号）。 */
function ImageField({
  label,
  type,
  image,
  uploads,
  onChange,
}: {
  label: string
  type: AplusModuleType
  image: AplusImage | null
  uploads: readonly AplusUploadRow[]
  onChange: (image: AplusImage | null) => void
}) {
  const size = imageSizeText(type)
  const known = uploads.some(upload => upload.uploadDestinationId === image?.uploadDestinationId)
  const options = [
    ...uploads.map(upload => {
      const state = imageOptionState(upload, type)
      return {
        value: upload.uploadDestinationId ?? upload.id,
        disabled: !state.usable,
        label: `${upload.fileName}（${upload.width}×${upload.height}）${state.reason ? `——${state.reason}` : ''}`,
      }
    }),
    ...(image && !known ? [{ value: image.uploadDestinationId, disabled: false, label: `已选图片（编号 ${image.uploadDestinationId}，不在图片库里）` }] : []),
  ]
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 2 }}>{label}（图片）</div>
      <Select
        allowClear
        virtual={false}
        style={{ width: '100%' }}
        placeholder="从图片库选择（只列出已上传成功的图片）"
        aria-label={label}
        value={image?.uploadDestinationId}
        options={options}
        onChange={value => onChange(value ? { uploadDestinationId: String(value), altText: image?.altText ?? '' } : null)}
        notFoundContent="图片库里还没有已上传成功的图片，请先到“图片库”上传"
      />
      {size ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          这个模块要求图片至少 {size}（原图宽高都不能小于它，提交时从左上角裁剪）
        </Typography.Text>
      ) : null}
      {image ? (
        <div style={{ marginTop: 4 }}>
          <Input aria-label={`${label}替代文字`} placeholder="图片替代文字（必填）" value={image.altText} onChange={event => onChange({ ...image, altText: event.target.value })} />
          <Counter value={image.altText} max={APLUS_TEXT_LIMITS.altText} />
        </div>
      ) : null}
    </div>
  )
}

function BlockFields({
  prefix,
  type,
  block,
  uploads,
  onChange,
}: {
  prefix: string
  type: AplusModuleType
  block: AplusImageBlock
  uploads: readonly AplusUploadRow[]
  onChange: (block: AplusImageBlock) => void
}) {
  return (
    <>
      <ImageField label={prefix} type={type} image={block.image} uploads={uploads} onChange={image => onChange({ ...block, image })} />
      <TextField label={`${prefix}标题`} value={block.headline} max={APLUS_TEXT_LIMITS.headline} onChange={headline => onChange({ ...block, headline })} />
      <TextField label={`${prefix}正文`} value={block.body} max={APLUS_TEXT_LIMITS.body} rows={3} onChange={body => onChange({ ...block, body })} />
    </>
  )
}

/** 一个模块的表单；n 是模块序号（从 1 起），用来区分各模块里同名的输入框。 */
export function ModuleForm({ module, n, uploads, onChange }: { module: AplusFormModule; n: number; uploads: readonly AplusUploadRow[]; onChange: Change }) {
  const at = `模块 ${n}`
  const { headline, body } = APLUS_TEXT_LIMITS
  switch (module.type) {
    case 'STANDARD_TEXT':
      return (
        <>
          <TextField label={`${at} 标题`} value={module.headline} max={headline} onChange={value => onChange({ ...module, headline: value })} />
          <TextField label={`${at} 正文`} value={module.body} max={body} rows={4} onChange={value => onChange({ ...module, body: value })} />
        </>
      )
    case 'STANDARD_PRODUCT_DESCRIPTION':
      return <TextField label={`${at} 正文`} value={module.body} max={body} rows={5} onChange={value => onChange({ ...module, body: value })} />
    case 'STANDARD_COMPANY_LOGO':
      return <ImageField label={`${at} 标志`} type={module.type} image={module.image} uploads={uploads} onChange={image => onChange({ ...module, image })} />
    case 'STANDARD_HEADER_IMAGE_TEXT':
      return (
        <>
          <TextField label={`${at} 总标题`} value={module.headline} max={headline} onChange={value => onChange({ ...module, headline: value })} />
          <BlockFields prefix={`${at} 大图`} type={module.type} block={module.block} uploads={uploads} onChange={block => onChange({ ...module, block })} />
        </>
      )
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return (
        <>
          <Radio.Group
            aria-label={`${at} 图片位置`}
            style={{ marginBottom: 8 }}
            value={module.position}
            onChange={event => onChange({ ...module, position: event.target.value })}
            options={[
              { value: 'LEFT', label: '图在左' },
              { value: 'RIGHT', label: '图在右' },
            ]}
          />
          <BlockFields prefix={`${at} 侧图`} type={module.type} block={module.block} uploads={uploads} onChange={block => onChange({ ...module, block })} />
        </>
      )
    case 'STANDARD_THREE_IMAGE_TEXT':
      return (
        <>
          <TextField label={`${at} 总标题`} value={module.headline} max={headline} onChange={value => onChange({ ...module, headline: value })} />
          {module.blocks.map((block, index) => (
            <BlockFields
              key={index}
              prefix={`${at} 图 ${index + 1}`}
              type={module.type}
              block={block}
              uploads={uploads}
              onChange={next => onChange({ ...module, blocks: module.blocks.map((item, i) => (i === index ? next : item)) as typeof module.blocks })}
            />
          ))}
        </>
      )
  }
}

export const moduleTitle = (type: AplusModuleType): string => `${APLUS_MODULE_DEFS[type].label}（${APLUS_MODULE_DEFS[type].description}）`
