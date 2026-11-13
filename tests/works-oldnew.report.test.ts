// 임시 비교: 같은 실제 스냅샷에 "아무것도 안 바꾼 저장"을 옛 코드(HEAD)와 새 코드로 흉내 내어 나가는 본문을 견준다.
// ATELIER_SNAPSHOTS, ATELIER_OLD(옛 소스 루트), ATELIER_OLDNEW_OUT 이 있을 때만 돈다. 플랫폼에는 아무것도 보내지 않는다.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { workAdapter } from '../src/main/works/adapters'
import { rawDiff } from '../src/main/works/raw-diff'
import type { WorkAdapter, WorkIo, WorkRequest } from '../src/main/works/types'

const ROOT = process.env.ATELIER_SNAPSHOTS ?? ''
const OLD = process.env.ATELIER_OLD ?? ''
const OUT = process.env.ATELIER_OLDNEW_OUT ?? ''
const PLATFORMS = ['eden', 'babe', 'genit', 'elyn', 'neko', 'crack', 'rplay', 'teapot', 'uumai', 'chatple']

function latest(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

async function run(adapter: WorkAdapter, work: string, raw: unknown): Promise<{ sent: unknown[]; error: string | null }> {
  const sent: unknown[] = []
  const answer = (): Response =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const io: WorkIo = {
    read: async () => answer(),
    write: async (method, url, body) => {
      sent.push({ method, url, body })
      return answer()
    },
    send: async (request: WorkRequest) => {
      sent.push({
        method: request.method,
        url: request.url,
        body: request.json ?? request.form?.map((f) => ('value' in f ? [f.name, f.value] : [f.name, 'file']))
      })
      return answer()
    }
  }
  try {
    const next = adapter.applyChanges!(structuredClone(raw), {})
    await adapter.save!(io.write, work, next, io)
    return { sent, error: null }
  } catch (error) {
    return { sent, error: String((error as Error).message).slice(0, 60) }
  }
}

describe.skipIf(!ROOT || !OLD || !existsSync(ROOT) || !existsSync(OLD))('옛 코드 대 새 코드', () => {
  it('아무것도 안 바꾼 저장의 본문이 어디서 달라졌는지', async () => {
    const old = (await import(pathToFileURL(join(OLD, 'src/main/works/adapters.ts')).href)) as {
      workAdapter: typeof workAdapter
    }
    const lines = ['# 옛 코드 대 새 코드: 안 바꾼 저장의 본문 비교', '']
    for (const platform of PLATFORMS) {
      const base = join(ROOT, platform)
      if (!existsSync(base)) continue
      const a = old.workAdapter(platform)
      const b = workAdapter(platform)
      if (!a.applyChanges || !a.save || !b.applyChanges || !b.save) continue
      const paths = new Map<string, number>()
      const errors = new Map<string, number>()
      let works = 0
      let same = 0
      for (const work of readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory() && !n.includes('.save-report'))) {
        const file = latest(join(base, work))
        if (!file) continue
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          continue
        }
        works++
        const x = await run(a, work, raw)
        const y = await run(b, work, raw)
        if (x.error !== y.error) {
          const key = '오류: 옛=' + x.error + ' 새=' + y.error
          errors.set(key, (errors.get(key) ?? 0) + 1)
        }
        const diff = rawDiff(x.sent, y.sent, 400)
        if (!diff.length && x.error === y.error) same++
        for (const d of diff) {
          const key =
            d.path.replace(/\[[^\]]*\]/g, '[]') + ' ' + d.kind + (d.before !== undefined ? ' ' + d.before : '') + (d.after !== undefined ? ' → ' + d.after : '')
          paths.set(key, (paths.get(key) ?? 0) + 1)
        }
      }
      lines.push('## ' + platform, '', '- 작품 ' + works + '개 중 본문이 완전히 같은 것 ' + same + '개')
      for (const [key, n] of errors) lines.push('- ' + key + ' ×' + n)
      for (const [key, n] of [...paths].sort((p, q) => q[1] - p[1]).slice(0, 40)) lines.push('- `' + key + '` ×' + n)
      lines.push('')
    }
    if (OUT) writeFileSync(OUT, lines.join('\n'))
    expect(lines.length).toBeGreaterThan(2)
  })
})
