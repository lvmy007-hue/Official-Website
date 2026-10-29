import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Breadcrumb, Button, Modal, Space } from 'antd'
import { back, canBack, canForward, currentLevel, forward, goTo, pushLevel, startStack, trail, type DrillEntry, type DrillStack } from './drill-stack'
import './detail.css'

// 弹窗下钻（P6-05，15 章第 8 节）：屏宽 90% 的大弹窗，内部放列表骨架（PagedGrid / MassiveGrid）；
// 层级对象（广告活动 → 广告组 → 投放 → 搜索词）可以连续下钻，下钻链存为栈：顶部面包屑可以回到任意一层，
// 还有“后退 / 前进”；关闭弹窗时整条链一起关闭（下次打开从根层重新开始）。
// 每一层的内容由调用方给出（render），内容里用 useDrill().push 继续下钻。

export type DrillLevel = DrillEntry & { render: () => ReactNode }

type DrillApi = {
  /** 当前层之下再下钻一层；同一个 key 已在当前层时忽略。 */
  push: (level: DrillLevel) => void
  /** 栈深（根层为 1）。 */
  depth: number
}

const DrillContext = createContext<DrillApi | null>(null)

/** 取下钻操作；不在 DrillModal 里使用时返回 null（内容可以单独当整页渲染）。 */
export const useDrill = () => useContext(DrillContext)

export type DrillModalProps = {
  open: boolean
  /** 关闭整条下钻链。 */
  onClose: () => void
  /** 根层；换了 key 表示换了一个根对象，栈从头开始。 */
  root: DrillLevel
  /** 默认屏宽 90%。 */
  width?: string | number
  /** 标题前缀（对象类型名），显示在面包屑左侧。 */
  heading?: string
}

export function DrillModal({ open, onClose, root, width = '90vw', heading }: DrillModalProps) {
  const [stack, setStack] = useState<DrillStack<DrillLevel>>(() => startStack(root))
  // 每次重新打开、或换了根对象，都从根层开始
  useEffect(() => {
    if (open) setStack(startStack(root))
    // 根层的 render 每次都是新函数，只按 key 与开关重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root.key])

  const push = useCallback((level: DrillLevel) => setStack(prev => pushLevel(prev, level)), [])
  const api = useMemo<DrillApi>(() => ({ push, depth: stack.index + 1 }), [push, stack.index])
  const here = currentLevel(stack)
  const crumbs = trail(stack)

  const title: ReactNode = (
    <div className="erp-drill-head">
      <Space size={4}>
        <Button size="small" type="text" disabled={!canBack(stack)} onClick={() => setStack(prev => back(prev))} aria-label="后退一层">
          ‹ 后退
        </Button>
        <Button size="small" type="text" disabled={!canForward(stack)} onClick={() => setStack(prev => forward(prev))} aria-label="前进一层">
          前进 ›
        </Button>
      </Space>
      <Breadcrumb
        items={[
          ...(heading ? [{ title: heading }] : []),
          ...crumbs.map((level, index) => ({
            key: level.key,
            title:
              index === crumbs.length - 1 ? (
                <span aria-current="page">{level.title}</span>
              ) : (
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => setStack(prev => goTo(prev, index))}>
                  {level.title}
                </Button>
              ),
          })),
        ]}
      />
    </div>
  )

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={width} centered destroyOnClose title={title} styles={{ body: { maxHeight: '75vh', overflow: 'auto' } }} className="erp-drill-modal">
      <DrillContext.Provider value={api}>{here ? <div key={here.key}>{here.render()}</div> : null}</DrillContext.Provider>
    </Modal>
  )
}
