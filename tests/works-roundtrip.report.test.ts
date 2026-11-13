// 실제 작품 스냅샷으로 "아무것도 안 바꾸고 저장"을 흉내 내, 저장 본문에서 빠지는 원본 칸을 센다.
// 플랫폼에는 아무것도 보내지 않는다(쓰기 통로는 가짜). 스냅샷 폴더가 있을 때만 돈다:
//   ATELIER_SNAPSHOTS=<...\Atelier\mcp\snapshots> ATELIER_ROUNDTRIP_OUT=<보고서.md> npx vitest run tests/works-roundtrip.report.test.ts
// 보고서에는 칸 이름과 개수만 적고 작품 내용은 적지 않는다.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workAdapter } from '../src/main/works/adapters'
import { rawDiff } from '../src/main/works/raw-diff'
import type { WorkIo, WorkRequest } from '../src/main/works/types'

const ROOT = process.env.ATELIER_SNAPSHOTS ?? ''
const OUT = process.env.ATELIER_ROUNDTRIP_OUT ?? ''
const PLATFORMS = ['eden', 'babe', 'genit', 'elyn', 'neko', 'crack', 'rplay', 'teapot', 'uumai', 'chatple']
const PER_PLATFORM = 12

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const filled = (v: unknown): boolean =>
  !(v === null || v === undefined || v === '' || v === false || v === 0) &&
  !(Array.isArray(v) && v.length === 0) &&
  !(isObj(v) && Object.keys(v).length === 0)

/** 원본의 모든 칸 이름과, 그 칸에 값이 든 적이 있는지 */
function keysOf(v: unknown, out = new Map<string, boolean>()): Map<string, boolean> {
  if (Array.isArray(v)) for (const item of v) keysOf(item, out)
  else if (isObj(v))
    for (const [name, value] of Object.entries(v)) {
      out.set(name, (out.get(name) ?? false) || filled(value))
      keysOf(value, out)
    }
  return out
}
const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const norm = (name: string): string => snake(name).replace(/_/g, '').toLowerCase()

function latest(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

interface Row {
  works: number
  failed: Record<string, number>
  noop: number
  /** 빠진 칸 이름 → [작품 수, 값이 들어 있던 작품 수] */
  lost: Map<string, [number, number]>
  requests: Map<string, number>
}

describe.skipIf(!ROOT || !existsSync(ROOT))('스냅샷 왕복 보고', () => {
  it('저장 본문에서 빠지는 원본 칸을 플랫폼별로 센다', async () => {
    const rows = new Map<string, Row>()
    for (const platform of PLATFORMS) {
      const base = join(ROOT, platform)
      if (!existsSync(base)) continue
      const adapter = workAdapter(platform)
      const row: Row = { works: 0, failed: {}, noop: 0, lost: new Map(), requests: new Map() }
      rows.set(platform, row)
      if (!adapter.applyChanges || !adapter.save) continue
      const works = readdirSync(base).filter(
        (name) => statSync(join(base, name)).isDirectory() && !name.endsWith('.save-report')
      )
      for (const work of works.slice(0, PER_PLATFORM)) {
        const file = latest(join(base, work))
        if (!file) continue
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          continue
        }
        const sent: unknown[] = []
        const answer = (): Response =>
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        const note = (method: string, url: string): void => {
          const key = method + ' ' + new URL(url).pathname.replace(/[0-9a-f-]{8,}|\d{3,}/gi, '{id}')
          row.requests.set(key, (row.requests.get(key) ?? 0) + 1)
        }
        const io: WorkIo = {
          read: async () => answer(),
          write: async (method, url, body) => {
            note(method, url)
            sent.push(body)
            return answer()
          },
          send: async (request: WorkRequest) => {
            note(request.method, request.url)
            sent.push(request.json ?? request.form?.map((f) => ('value' in f ? { [f.name]: f.value } : { [f.name]: 'file' })))
            return answer()
          }
        }
        row.works++
        try {
          const next = adapter.applyChanges(raw, {})
          // 아무것도 안 바꿨는데 원본이 달라지면 그것도 적는다
          if (rawDiff(raw, next, 1).length === 0) row.noop++
          await adapter.save(io.write, work, next, io)
        } catch (error) {
          const code = String((error as Error).message).slice(0, 40)
          row.failed[code] = (row.failed[code] ?? 0) + 1
          if (!sent.length) continue
        }
        const sentKeys = new Set([...keysOf(sent).keys()].map(norm))
        // 저장 본문에 글로 통째 실리는 값(JSON 문자열 등)도 칸 이름으로 찾는다
        const blob = JSON.stringify(sent)
        for (const [name, hasValue] of keysOf(raw)) {
          if (sentKeys.has(norm(name)) || blob.includes('\\"' + name + '\\"')) continue
          const [n, v] = row.lost.get(name) ?? [0, 0]
          row.lost.set(name, [n + 1, v + (hasValue ? 1 : 0)])
        }
      }
    }

    const lines = [
      '# 스냅샷 왕복 보고',
      '',
      '실제 작품 스냅샷에 "아무것도 안 바꾼 저장"을 흉내 내어, 원본에는 있는데 저장 본문에 이름이 없는 칸을 센 것.',
      '이름으로만 견주므로 사이트가 저장 때 다른 이름으로 받는 칸, 읽기 전용 칸(통계·시각)도 여기에 나온다. 값이 들어 있던 칸부터 본다.',
      ''
    ]
    for (const [platform, row] of rows) {
      lines.push('## ' + platform, '')
      lines.push(
        '- 작품 ' + row.works + '개, 그중 "안 바꾸면 원본 그대로"인 것 ' + row.noop + '개' +
          (Object.keys(row.failed).length ? ', 저장 흉내 중 오류: ' + JSON.stringify(row.failed) : '')
      )
      lines.push('- 보낸 요청: ' + ([...row.requests].map(([k, n]) => k + ' ×' + n).join(', ') || '없음'))
      const lost = [...row.lost].sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0])
      const withValue = lost.filter(([, [, v]]) => v > 0)
      const empty = lost.filter(([, [, v]]) => v === 0)
      lines.push('- 값이 든 채 빠지는 칸 ' + withValue.length + '개: ' + (withValue.map(([k, [, v]]) => k + '(' + v + ')').join(', ') || '없음'))
      lines.push('- 빈 값이라 지금은 해가 없는 칸 ' + empty.length + '개: ' + (empty.map(([k]) => k).join(', ') || '없음'), '')
    }
    const report = lines.join('\n')
    if (OUT) writeFileSync(OUT, report)
    expect(rows.size).toBeGreaterThan(0)
  })
})
