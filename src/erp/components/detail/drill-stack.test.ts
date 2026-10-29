import { describe, expect, it } from 'vitest'
import { back, canBack, canForward, currentLevel, emptyStack, forward, goTo, pushLevel, startStack, trail, type DrillEntry } from './drill-stack'

// 下钻栈（P6-05）：纯函数。

const L = (key: string): DrillEntry => ({ key, title: `层 ${key}` })
const keys = (stack: Parameters<typeof trail>[0]) => trail(stack).map(level => level.key)

describe('下钻栈', () => {
  it('从根层开始：只有一层，不能后退也不能前进', () => {
    const stack = startStack(L('a'))
    expect(keys(stack)).toEqual(['a'])
    expect(currentLevel(stack)?.key).toBe('a')
    expect(canBack(stack)).toBe(false)
    expect(canForward(stack)).toBe(false)
  })

  it('空栈没有当前层，后退与前进都不动', () => {
    const stack = emptyStack()
    expect(currentLevel(stack)).toBeNull()
    expect(back(stack)).toBe(stack)
    expect(forward(stack)).toBe(stack)
  })

  it('连续下钻，面包屑是从根到当前层', () => {
    const stack = pushLevel(pushLevel(startStack(L('campaign')), L('group')), L('target'))
    expect(keys(stack)).toEqual(['campaign', 'group', 'target'])
    expect(canBack(stack)).toBe(true)
  })

  it('后退保留后面的层，可以前进回去；回到任意一层也保留后面的层', () => {
    let stack = pushLevel(pushLevel(startStack(L('a')), L('b')), L('c'))
    stack = back(stack)
    expect(keys(stack)).toEqual(['a', 'b'])
    expect(canForward(stack)).toBe(true)
    stack = forward(stack)
    expect(keys(stack)).toEqual(['a', 'b', 'c'])
    stack = goTo(stack, 0)
    expect(keys(stack)).toEqual(['a'])
    expect(canForward(stack)).toBe(true)
    expect(keys(forward(forward(stack)))).toEqual(['a', 'b', 'c'])
  })

  it('在非末层再下钻，丢掉后面的层（和浏览器历史一样）', () => {
    let stack = pushLevel(pushLevel(startStack(L('a')), L('b')), L('c'))
    stack = back(back(stack))
    stack = pushLevel(stack, L('x'))
    expect(keys(stack)).toEqual(['a', 'x'])
    expect(canForward(stack)).toBe(false)
  })

  it('同一层重复下钻不入栈；越界的跳转忽略', () => {
    const stack = pushLevel(startStack(L('a')), L('b'))
    expect(pushLevel(stack, L('b'))).toBe(stack)
    expect(goTo(stack, 5)).toBe(stack)
    expect(goTo(stack, -1)).toBe(stack)
    expect(goTo(stack, 1.5)).toBe(stack)
    expect(goTo(stack, 1)).toBe(stack)
  })
})
