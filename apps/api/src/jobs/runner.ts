import type { JobStore, ClaimedJob } from './store.js'

export interface JobContext {
  jobId: string
  signal: AbortSignal
  payload: Record<string, unknown>
  reportProgress: (progress: number) => Promise<void>
}

export type JobHandler = (context: JobContext) => Promise<object | null>

export class JobRunner {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >()

  constructor(
    private readonly store: JobStore,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly options: { pollIntervalMs: number; concurrency: number },
  ) {}

  async start(): Promise<void> {
    if (this.timer) return
    await this.store.recoverInterrupted()
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs)
    this.timer.unref()
    await this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const { controller } of this.active.values()) controller.abort()
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise))
  }

  async cancel(id: string): Promise<boolean> {
    this.active.get(id)?.controller.abort()
    return this.store.cancel(id)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      while (this.active.size < this.options.concurrency) {
        const job = await this.store.claim()
        if (!job) break
        const controller = new AbortController()
        const promise = this.execute(job, controller)
        this.active.set(job.id, { controller, promise })
        void promise.finally(() => {
          this.active.delete(job.id)
          void this.tick()
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private async execute(job: ClaimedJob, controller: AbortController): Promise<void> {
    const handler = this.handlers.get(job.type)
    if (!handler) {
      await this.store.fail(job.id, `No handler is registered for ${job.type}`)
      return
    }
    const timeout = setTimeout(() => controller.abort(new Error('Job timed out')), job.timeoutMs)
    try {
      const result = await handler({
        jobId: job.id,
        payload: job.payload,
        signal: controller.signal,
        reportProgress: (progress) => this.store.progress(job.id, progress),
      })
      await this.store.succeed(job.id, result)
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Job cancelled or timed out'
        : error instanceof Error
          ? error.message
          : 'Unknown job error'
      await this.store.fail(job.id, message)
    } finally {
      clearTimeout(timeout)
    }
  }
}
