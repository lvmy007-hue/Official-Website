import { useState } from 'react'
import {
  OVERVIEW_LAYOUT_VIEW_NAME,
  OVERVIEW_VIEW_PAGE_KEY,
  OverviewLayoutSchema,
  overviewTemplateOf,
  type KpiKey,
  type OverviewLayout,
  type OverviewSection,
  type OverviewTemplate,
} from '@nova/api-contracts'
import { useApiMutation, useApiQuery } from '../../query/api-query'

// 控制台布局：4 种视图模板 + 个人隐藏项。个人布局保存在“保存视图”里（页面标识 overview，名称“我的布局”，仅本人可见）。
// 打开页面时用已保存的个人布局；在页面上切换模板或勾选隐藏项只是临时调整，点“保存为我的布局”才会保存。

type SavedItem = { id: string; name: string; mine: boolean; version: number; filter: unknown }

export const defaultLayout = (template: OverviewTemplate = 'owner'): OverviewLayout => ({ template, hiddenSections: [], hiddenCards: [] })

/** 当前布局下实际显示的区域与指标卡（顺序跟随模板）。 */
export function visibleParts(layout: OverviewLayout): { sections: OverviewSection[]; cards: KpiKey[] } {
  const spec = overviewTemplateOf(layout.template)
  return {
    sections: spec.sections.filter(section => !layout.hiddenSections.includes(section)),
    cards: spec.cards.filter(card => !layout.hiddenCards.includes(card)),
  }
}

export function useOverviewLayout() {
  const list = useApiQuery<{ items: SavedItem[] }>({ domain: 'config', path: '/views', scoped: false, params: { pageKey: OVERVIEW_VIEW_PAGE_KEY } })
  const [draft, setDraft] = useState<OverviewLayout | null>(null)
  const saved = list.data?.items.find(item => item.mine && item.name === OVERVIEW_LAYOUT_VIEW_NAME)
  const parsed = OverviewLayoutSchema.safeParse(saved?.filter)
  const savedLayout = parsed.success ? parsed.data : null
  const layout = draft ?? savedLayout ?? defaultLayout()

  const create = useApiMutation<OverviewLayout, unknown>({
    method: 'POST',
    path: '/views',
    body: value => ({ pageKey: OVERVIEW_VIEW_PAGE_KEY, name: OVERVIEW_LAYOUT_VIEW_NAME, filterJson: value, columnsJson: [], sortJson: [], shared: false, isDefault: false }),
    invalidate: ['config'],
  })
  const update = useApiMutation<{ id: string; version: number; layout: OverviewLayout }, unknown>({
    method: 'PATCH',
    path: value => `/views/${encodeURIComponent(value.id)}`,
    body: value => ({ version: value.version, filterJson: value.layout }),
    invalidate: ['config'],
  })

  return {
    layout,
    /** 当前布局与已保存的个人布局是否一致 */
    dirty: JSON.stringify(layout) !== JSON.stringify(savedLayout ?? defaultLayout()),
    hasSaved: savedLayout !== null,
    loading: list.isPending,
    saving: create.isPending || update.isPending,
    setTemplate: (template: OverviewTemplate) => setDraft(defaultLayout(template)),
    toggleSection: (section: OverviewSection, visible: boolean) =>
      setDraft({ ...layout, hiddenSections: visible ? layout.hiddenSections.filter(item => item !== section) : [...layout.hiddenSections, section] }),
    toggleCard: (card: KpiKey, visible: boolean) => setDraft({ ...layout, hiddenCards: visible ? layout.hiddenCards.filter(item => item !== card) : [...layout.hiddenCards, card] }),
    reset: () => setDraft(savedLayout ?? defaultLayout()),
    save: async () => {
      if (saved) await update.mutateAsync({ id: saved.id, version: saved.version, layout })
      else await create.mutateAsync(layout)
      setDraft(null)
    },
  }
}
