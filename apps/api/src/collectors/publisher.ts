import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class TelegrafConfigPublisher {
  constructor(private readonly root: string) {}

  async publish(revisionId: string, content: string): Promise<void> {
    const active = join(this.root, 'active')
    const revisions = join(this.root, 'revisions')
    await Promise.all([
      mkdir(active, { recursive: true, mode: 0o700 }),
      mkdir(revisions, { recursive: true, mode: 0o700 }),
    ])
    await writeFile(join(revisions, `${revisionId}.conf`), content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    const temporary = join(active, `.managed-${revisionId}.tmp`)
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, join(active, 'managed.conf'))
  }

  async restore(content: string): Promise<void> {
    const active = join(this.root, 'active')
    await mkdir(active, { recursive: true, mode: 0o700 })
    const temporary = join(active, `.restore-${Date.now()}.tmp`)
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, join(active, 'managed.conf'))
  }

  async clearActive(): Promise<void> {
    try {
      await unlink(join(this.root, 'active', 'managed.conf'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
