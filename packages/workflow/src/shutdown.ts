// 优雅停机（12.3）：收到停止信号后，先停止接新任务，等进行中的任务收尾，再释放连接；超时则强制退出，避免僵死。

export interface ShutdownLogger {
  info(message: string): void
  error(message: string): void
}

export class GracefulShutdown {
  private readonly steps: Array<{ name: string; fn: () => Promise<void> }> = []
  private running: Promise<void> | null = null

  constructor(private readonly options: { timeoutMs?: number; logger?: ShutdownLogger } = {}) {}

  /** 注册停机步骤：按注册的相反顺序执行（先停消费者，再关连接）。 */
  register(name: string, fn: () => Promise<void>) {
    this.steps.push({ name, fn })
  }

  /** 幂等：重复触发只执行一次。返回是否在超时内完整结束。 */
  run(): Promise<boolean> {
    this.running ??= this.execute()
    return this.running.then(() => this.completed)
  }

  private completed = false

  private async execute() {
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const logger = this.options.logger
    const work = (async () => {
      for (const step of [...this.steps].reverse()) {
        try {
          logger?.info(`停机步骤开始：${step.name}`)
          await step.fn()
        } catch (error) {
          logger?.error(`停机步骤失败：${step.name}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return true
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    this.completed = await Promise.race([work, timeout])
    if (timer) clearTimeout(timer)
    if (!this.completed) logger?.error(`停机超过 ${timeoutMs} 毫秒仍未结束，强制退出`)
  }
}
