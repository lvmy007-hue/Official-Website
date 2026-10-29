import { Result, type ResultProps } from 'antd'

// 状态结果视图：只是对 Ant Design Result 的一层承载，单独成文件是为了让它（含 403/404/500 插图）按需加载，
// 不占用首屏脚本预算（12.4，350KB）。使用方通过 LazyResult 引用。
export default function ResultView(props: ResultProps) {
  return <Result {...props} />
}
