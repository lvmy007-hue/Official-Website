import type { CSSProperties, ReactNode } from 'react'
import { Alert, Card, Typography } from 'antd'
import { APLUS_MODULE_DEFS, APLUS_PREVIEW_NOTE, aplusModuleLabel, type AplusFormModule, type AplusImage, type AplusImageBlock } from '@nova/api-contracts'
import { NONE_TEXT, rawModuleType } from './aplus-format'

// A+ 模块预览（P4-14）：接口只返回图片编号、不返回图片地址，所以文字用真实文字，图片用占位框（按模块要求的比例画虚线框，写尺寸与替代文字）。
// 不在编辑器支持范围的模块（转换结果为 null）写“不支持预览的模块：<类型>”。

const boxStyle = (width: number, height: number): CSSProperties => ({
  aspectRatio: `${width} / ${height}`,
  width: '100%',
  maxWidth: Math.min(width, 480),
  border: '1px dashed #8c8c8c',
  borderRadius: 4,
  background: '#fafafa',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 8,
  fontSize: 12,
  color: 'rgba(0,0,0,0.65)',
})

/** 图片占位框。 */
export function ImagePlaceholder({ type, image }: { type: AplusFormModule['type']; image: AplusImage | null }) {
  const size = APLUS_MODULE_DEFS[type].imageSize ?? { width: 300, height: 300 }
  return (
    <div data-testid="aplus-image-placeholder" style={boxStyle(size.width, size.height)}>
      {image ? (
        <>
          <strong>
            图片 {size.width}×{size.height}
          </strong>
          <span>替代文字：{image.altText || '未填写'}</span>
        </>
      ) : (
        <span>
          尚未选择图片（要求 {size.width}×{size.height}）
        </span>
      )}
    </div>
  )
}

const Text = ({ value, strong }: { value: string; strong?: boolean }) => (value ? <div style={{ whiteSpace: 'pre-wrap', fontWeight: strong ? 600 : undefined, margin: '4px 0' }}>{value}</div> : null)

function Block({ type, block }: { type: AplusFormModule['type']; block: AplusImageBlock }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <ImagePlaceholder type={type} image={block.image} />
      <Text value={block.headline} strong />
      <Text value={block.body} />
    </div>
  )
}

function ModuleBody({ module }: { module: AplusFormModule }): ReactNode {
  switch (module.type) {
    case 'STANDARD_TEXT':
      return (
        <>
          <Text value={module.headline} strong />
          <Text value={module.body} />
        </>
      )
    case 'STANDARD_PRODUCT_DESCRIPTION':
      return <Text value={module.body} />
    case 'STANDARD_COMPANY_LOGO':
      return <ImagePlaceholder type={module.type} image={module.image} />
    case 'STANDARD_HEADER_IMAGE_TEXT':
      return (
        <>
          <Text value={module.headline} strong />
          <Block type={module.type} block={module.block} />
        </>
      )
    case 'STANDARD_SINGLE_SIDE_IMAGE':
      return (
        <div style={{ display: 'flex', gap: 12, flexDirection: module.position === 'RIGHT' ? 'row-reverse' : 'row' }}>
          <div style={{ flex: '0 0 40%' }}>
            <ImagePlaceholder type={module.type} image={module.block.image} />
          </div>
          <div style={{ flex: 1 }}>
            <Text value={module.block.headline} strong />
            <Text value={module.block.body} />
          </div>
        </div>
      )
    case 'STANDARD_THREE_IMAGE_TEXT':
      return (
        <>
          <Text value={module.headline} strong />
          <div style={{ display: 'flex', gap: 12 }}>
            {module.blocks.map((block, index) => (
              <Block key={index} type={module.type} block={block} />
            ))}
          </div>
        </>
      )
  }
}

/** modules 与 raw 按位置对应：raw 是接口原样返回的模块，转不了的位置只用它取类型名。 */
export function AplusModulePreview({ modules, raw }: { modules: ReadonlyArray<AplusFormModule | null>; raw: readonly unknown[] }) {
  return (
    <div data-testid="aplus-preview">
      <Alert data-testid="aplus-preview-note" type="info" showIcon style={{ marginBottom: 8 }} message={APLUS_PREVIEW_NOTE} />
      {modules.length === 0 ? <Typography.Text type="secondary">{NONE_TEXT}：这份内容里还没有模块</Typography.Text> : null}
      {modules.map((module, index) => (
        <Card key={index} size="small" style={{ marginBottom: 8 }} title={`模块 ${index + 1} · ${module ? aplusModuleLabel(module.type) : aplusModuleLabel(rawModuleType(raw[index]))}`}>
          {module ? <ModuleBody module={module} /> : <Typography.Text type="warning">不支持预览的模块：{rawModuleType(raw[index])}</Typography.Text>}
        </Card>
      ))}
    </div>
  )
}
