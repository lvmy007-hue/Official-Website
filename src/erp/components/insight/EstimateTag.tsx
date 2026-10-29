import { Tag, Tooltip } from 'antd'

// 模型估算标注（3.3“专业感”：每个估算标注“模型估算”及方法）。
// 预测、模拟、近实时数字旁一律放这个标签，悬停说明方法与区间。

export function EstimateTag({ method, range, realtime }: { method: string; /** 区间说明，例如“低 120 / 中 150 / 高 190 件”。 */ range?: string; realtime?: boolean }) {
  return (
    <Tooltip
      title={
        <div style={{ maxWidth: 260 }}>
          <div>方法：{method}</div>
          {range ? <div>区间：{range}</div> : null}
          {realtime ? <div>实时估算，以日终数据为准</div> : null}
        </div>
      }
    >
      <Tag color="purple" bordered={false} style={{ cursor: 'help', marginInlineEnd: 0 }}>
        {realtime ? '实时估算' : '模型估算'}
      </Tag>
    </Tooltip>
  )
}
