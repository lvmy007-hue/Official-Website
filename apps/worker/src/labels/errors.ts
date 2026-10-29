/** 标签生成的可预期失败：code 对应导出中心里给用户看的失败原因（EXPORT_ERROR_LABEL），message 是写进任务的具体说明。 */
export class LabelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
