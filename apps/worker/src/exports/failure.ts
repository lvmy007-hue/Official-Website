/** 单个导出文件的大小上限；超过即中止并丢弃（不留半个文件） */
export const EXPORT_MAX_FILE_BYTES = 500 * 1024 * 1024

/** 导出的可预期失败：code 落到任务上，界面显示对应的中文原因；不重试。 */
export class ExportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ExportFailure'
  }
}
