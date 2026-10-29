// 连续下钻的栈（P6-05，15 章第 8 节“弹窗下钻”）：纯函数，不依赖界面。
// 栈里每一层是一个有标题的对象（例如“广告活动 A”→“广告组 B”→“投放 C”）；位置 index 指向当前层，
// 回退只移动位置、保留后面的层，所以可以“前进”；在非末层再下钻会丢掉后面的层（和浏览器历史一样）。

export type DrillEntry = { key: string; title: string }

export type DrillStack<T extends DrillEntry = DrillEntry> = { levels: readonly T[]; index: number }

export const emptyStack = <T extends DrillEntry>(): DrillStack<T> => ({ levels: [], index: -1 })

export const startStack = <T extends DrillEntry>(root: T): DrillStack<T> => ({ levels: [root], index: 0 })

export const currentLevel = <T extends DrillEntry>(stack: DrillStack<T>): T | null => stack.levels[stack.index] ?? null

/** 面包屑：从根到当前层。 */
export const trail = <T extends DrillEntry>(stack: DrillStack<T>): readonly T[] => stack.levels.slice(0, stack.index + 1)

export const canBack = (stack: DrillStack<DrillEntry>) => stack.index > 0

export const canForward = (stack: DrillStack<DrillEntry>) => stack.index >= 0 && stack.index < stack.levels.length - 1

/** 下钻一层：丢掉当前层后面的层；同一个 key 已在当前层时不重复入栈。 */
export function pushLevel<T extends DrillEntry>(stack: DrillStack<T>, level: T): DrillStack<T> {
  const here = currentLevel(stack)
  if (here && here.key === level.key) return stack
  const kept = stack.levels.slice(0, stack.index + 1)
  return { levels: [...kept, level], index: kept.length }
}

export function back<T extends DrillEntry>(stack: DrillStack<T>): DrillStack<T> {
  return canBack(stack) ? { ...stack, index: stack.index - 1 } : stack
}

export function forward<T extends DrillEntry>(stack: DrillStack<T>): DrillStack<T> {
  return canForward(stack) ? { ...stack, index: stack.index + 1 } : stack
}

/** 回到面包屑里的任意一层（按位置）；越界忽略。 */
export function goTo<T extends DrillEntry>(stack: DrillStack<T>, index: number): DrillStack<T> {
  if (!Number.isInteger(index) || index < 0 || index > stack.index) return stack
  return index === stack.index ? stack : { ...stack, index }
}
