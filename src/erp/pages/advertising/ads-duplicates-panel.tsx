import { useState } from 'react'
import { Alert, Collapse } from 'antd'
import type { AdsDuplicateKeyword, AdsDuplicateKeywordsResponse } from '@nova/api-contracts'
import { RIGHT_ALIGNED, renderColumn, type ErpColDef } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { Muted } from '../inventory/inventory-ui'
import { ToolGrid } from './ads-tools-grid'

// 重复关键词（P6-24）：同一个广告账户里，同一个词在同一种匹配方式下出现在多个广告组（已归档的不算，词不分大小写、空格合并）。
// 重复会让自己的广告组互相竞价；这里只列出位置，不自动改动，处理（暂停或删除其中一个）在各自的投放详情里做。展开才读取。

const columns: ErpColDef<AdsDuplicateKeyword>[] = [
  renderColumn<AdsDuplicateKeyword>('关键词', 'text', row => row.text, { pin: 'left', width: 220, sortable: false }),
  renderColumn<AdsDuplicateKeyword>('匹配方式', 'matchLabel', row => row.matchLabel, { width: 110, sortable: false }),
  renderColumn<AdsDuplicateKeyword>('广告组数', 'adGroupCount', row => row.adGroupCount, { width: 90, sortable: false, ...RIGHT_ALIGNED }),
  renderColumn<AdsDuplicateKeyword>(
    '出现的位置',
    'locations',
    row => (
      <span>
        {row.locations.map(item => (
          <span key={item.keywordId} style={{ marginRight: 12 }}>
            <AppLink to={`/app/advertising/targets/${encodeURIComponent(item.keywordId)}`}>{item.adGroupName ?? item.adGroupExternalId}</AppLink>
            <Muted>
              （{item.campaignName ?? '未知活动'}，{item.state}）
            </Muted>
          </span>
        ))}
      </span>
    ),
    { width: 640, sortable: false },
  ),
]

export function DuplicatesPanel() {
  const [meta, setMeta] = useState<AdsDuplicateKeywordsResponse | null>(null)
  return (
    <Collapse
      size="small"
      style={{ marginTop: 12 }}
      data-testid="ads-duplicates-panel"
      items={[
        {
          key: 'duplicates',
          label: `重复关键词${meta ? `（${meta.total} 组）` : ''}`,
          children: (
            <div>
              {meta?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="关键词数量超过读取上限，只判断了前一部分" /> : null}
              <ToolGrid<AdsDuplicateKeyword, AdsDuplicateKeywordsResponse>
                gridId="ads.duplicate-keywords"
                path="/ads/duplicate-keywords"
                columns={columns}
                getRowId={row => row.key}
                emptyDomain="重复关键词"
                emptyNote={meta?.note ?? '没有发现重复：同一个词在同一种匹配方式下没有出现在多个广告组。'}
                onFirstPage={setMeta}
              />
            </div>
          ),
        },
      ]}
    />
  )
}
