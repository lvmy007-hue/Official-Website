import { useState } from 'react'
import { Alert, Button, Input, Space, Tag } from 'antd'
import { type AdsRuleDryRunResponse, type AdsRuleRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiMutation } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { StateNote } from './ads-ui'
import { hitColumns, skipColumns } from './ads-rules-tables'

// 试运行（P3-13）：按规则现在的内容与库里的日级指标算一遍会命中哪些对象，只读，不生成待办，不改亚马逊。
// 评估截止日可以选（最晚到昨天）；不选就用昨天（按企业时区）。

export function DryRunPanel({ rule }: { rule: AdsRuleRow }) {
  const [asOf, setAsOf] = useState('')
  const [result, setResult] = useState<AdsRuleDryRunResponse | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const mutation = useApiMutation<{ asOf?: string }, AdsRuleDryRunResponse>({
    method: 'POST',
    path: `/ads/rules/${rule.id}/dry-run`,
    body: variables => variables,
    silent: true,
  })
  const run = () => {
    setResult(null)
    setFailure(null)
    mutation.mutate(asOf ? { asOf } : {}, { onSuccess: data => setResult(data), onError: error => setFailure(describeError(error).message) })
  }
  return (
    <div data-testid="rule-dryrun">
      <Space wrap style={{ marginBottom: 8 }}>
        <span>评估截止日（可不填）</span>
        <Input type="date" aria-label="评估截止日" value={asOf} onChange={event => setAsOf(event.target.value)} style={{ width: 160 }} />
        <Button type="primary" loading={mutation.isPending} onClick={run}>
          试运行
        </Button>
        <Tag bordered={false}>只读，不生成待办</Tag>
      </Space>
      {failure ? <Alert type="error" showIcon message={failure} /> : null}
      {result ? (
        <div data-testid="rule-dryrun-result">
          {result.state !== 'OK' ? (
            <StateNote state={result.state} note={result.note} />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                评估截止 {result.asOf}（库里最新数据到 {result.dataThrough ?? '尚无记录'}）：评估 {result.evaluated} 个对象，命中 {result.matched} 个，每日上限 {result.dailyLimit} 个。
              </div>
              {result.incomplete ? <Alert type="warning" showIcon message="读取的对象或指标行数超过上限，评估可能不完整" /> : null}
              {result.truncated ? <Alert type="warning" showIcon message="命中或跳过的对象很多，只列出了前面一部分" /> : null}
              <SimpleGrid
                gridId="advertising.ads-rules-dryrun"
                columns={hitColumns()}
                rows={result.hits}
                rowKey={row => row.key}
                emptyState={{ kind: 'empty', domain: '命中对象', prerequisite: '按现有数据没有对象命中这条规则。' }}
              />
              {result.skipped.length > 0 ? (
                <SimpleGrid
                  gridId="advertising.rules-dryrun-skipped"
                  columns={skipColumns()}
                  rows={result.skipped}
                  rowKey={row => row.key}
                  emptyState={{ kind: 'empty', domain: '跳过的对象', prerequisite: '' }}
                />
              ) : null}
            </Space>
          )}
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
            {result.caveats.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
