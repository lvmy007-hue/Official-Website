import { useCallback, useState } from 'react'
import { applyBoxSpecs, copyBoxDraft, draftsFromServer, newBoxDraft, type BoxDraft, type BoxSpecs, type InboundBoxView } from '@nova/api-contracts'

// 装箱草稿的本地状态（P6-10）：箱子在浏览器里改，点“保存草稿”才写服务端。
// - 没有未保存的修改时，服务端数据一变（保存成功、别人改过、导入文件）就重新载入；有未保存的修改时不会被冲掉；
// - revision 每改一次加一，表格据此刷新（表格按重置键重新取行）。

type State = { source: string; boxes: BoxDraft[]; dirty: boolean; revision: number }

export function useBoxDraft(serverBoxes: readonly InboundBoxView[], sourceKey: string) {
  const [state, setState] = useState<State>(() => ({ source: sourceKey, boxes: draftsFromServer(serverBoxes), dirty: false, revision: 0 }))
  if (!state.dirty && state.source !== sourceKey) setState({ source: sourceKey, boxes: draftsFromServer(serverBoxes), dirty: false, revision: state.revision + 1 })

  const change = useCallback((update: (boxes: BoxDraft[]) => BoxDraft[]) => setState(current => ({ ...current, boxes: update(current.boxes), dirty: true, revision: current.revision + 1 })), [])
  return {
    boxes: state.boxes,
    dirty: state.dirty,
    revision: state.revision,
    add: useCallback(() => change(boxes => [...boxes, newBoxDraft(boxes)]), [change]),
    copy: useCallback((key: string) => change(boxes => copyBoxDraft(boxes, key)), [change]),
    remove: useCallback((key: string) => change(boxes => boxes.filter(box => box.key !== key)), [change]),
    replace: useCallback((next: BoxDraft) => change(boxes => boxes.map(box => (box.key === next.key ? next : box))), [change]),
    setSpecs: useCallback((keys: ReadonlySet<string>, specs: BoxSpecs) => change(boxes => applyBoxSpecs(boxes, keys, specs)), [change]),
    /** 放弃未保存的修改，回到服务端上的版本。 */
    discard: useCallback(() => setState(current => ({ source: current.source, boxes: draftsFromServer(serverBoxes), dirty: false, revision: current.revision + 1 })), [serverBoxes]),
    /** 保存成功：之后服务端数据变化时会重新载入。 */
    saved: useCallback(() => setState(current => ({ ...current, dirty: false })), []),
  }
}
