// 表格行取文字的测试辅助（AG Grid 以 row-id 标识行；固定列与滚动区各有一份，这里合并）。只在测试里使用。

/** 某一行（按 row-id）的全部文字。 */
export const rowTextById = (id: string): string =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(element => element.textContent ?? '')
    .join(' ')

/** 包含某个节点的那一行的全部文字。 */
export const rowTextOf = (node: HTMLElement): string => {
  const id = node.closest('[row-id]')?.getAttribute('row-id')
  return id === null || id === undefined ? '' : rowTextById(id)
}

/** 某个短语在文字里出现的次数。 */
export const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1
