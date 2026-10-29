// 读表格文件的文字：先按 UTF-8 严格解码；不是合法的 UTF-8（中文版 Excel 另存的“CSV（逗号分隔）”是 GBK）就按 GBK 解码，
// 免得中文表头变成乱码、被当成缺列。

export function decodeCsv(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gbk').decode(buffer)
  }
}

export const readCsvFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(decodeCsv(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
