// 실제 스냅샷으로 "바꾸려던 칸만 바뀌는가"를 본다. 플랫폼에는 아무것도 보내지 않는다(쓰기 통로는 가짜).
//   ATELIER_SNAPSHOTS=<스냅샷 루트> ATELIER_OLD=<옛 소스 루트(선택)> ATELIER_SCENARIOS_OUT=<보고서.md>
// 경우마다 (1) 새 코드에서 "안 바꾼 저장" 본문과 견줘 달라진 경로, (2) 옛 코드와 새 코드의 본문 차이를 적는다.
// 보고서에는 경로와 개수만 적고 작품 내용은 적지 않는다.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { workAdapter } from '../src/main/works/adapters'
import { rawDiff } from '../src/main/works/raw-diff'
import type { WorkAdapter, WorkBody, WorkChanges, WorkIo, WorkRequest } from '../src/main/works/types'

const ROOT = process.env.ATELIER_SNAPSHOTS ?? ''
const OLD = process.env.ATELIER_OLD ?? ''
const OUT = process.env.ATELIER_SCENARIOS_OUT ?? ''
const PLATFORMS = ['eden', 'babe', 'genit', 'elyn', 'neko', 'crack', 'rplay', 'teapot', 'uumai', 'chatple']
const MARK = ' 시험'

function latest(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

async function send(adapter: WorkAdapter, work: string, raw: unknown, changes: WorkChanges): Promise<{ sent: unknown[]; error: string | null }> {
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
    const next = adapter.applyChanges!(structuredClone(raw), structuredClone(changes))
    await adapter.save!(io.write, work, next, io)
    return { sent: open(sent) as unknown[], error: null }
  } catch (error) {
    // 가짜 서버의 빈 답 때문에 저장 뒤 단계에서 나는 오류는 본문이 이미 나간 뒤다
    return {
      sent: open(sent) as unknown[],
      error: String((error as Error).message).replace(/\d+/g, 'N').slice(0, 50)
    }
  }
}

/** 폼 칸이나 본문에 JSON 글로 실린 값은 풀어서 견준다 (젠잇·엘린). [이름, 값] 쌍의 목록은 이름으로 찾는 묶음으로 바꾼다 */
function open(v: unknown): unknown {
  if (typeof v === 'string' && /^[[{]/.test(v)) {
    try {
      return open(JSON.parse(v))
    } catch {
      return v
    }
  }
  if (Array.isArray(v)) {
    const pairs =
      v.length > 0 &&
      v.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string')
    if (pairs) {
      const seen = new Map<string, number>()
      return Object.fromEntries(
        (v as [string, unknown][]).map(([name, value]) => {
          const n = seen.get(name) ?? 0
          seen.set(name, n + 1)
          return [n ? name + '#' + n : name, open(value)]
        })
      )
    }
    return v.map(open)
  }
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([name, value]) => [name, open(value)]))
  return v
}

const strip = (path: string): string => path.replace(/\[[^\]]*\]/g, '[]')

const ORDER_KEY = /^(order|sort|sort_no|sortOrder|display_order|position|priority|index|indexLabel|seq)$/i
const plain = (v: unknown): string =>
  JSON.stringify(v, (key, value) => (ORDER_KEY.test(key) ? undefined : value))

/** 서로 다른 목록 가운데 "항목은 그대로이고 순서만 바뀐 것"이 아닌 목록의 경로 (순서·번호 칸은 빼고 본다) */
function notPermutations(x: unknown, y: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(x) && Array.isArray(y)) {
    if (plain(x) === plain(y)) return out
    const sorted = (list: unknown[]): string => list.map(plain).sort().join('\u0000')
    if (x.length === y.length && sorted(x) === sorted(y)) return out
    if (x.length !== y.length) {
      out.push(path + ' (개수 ' + x.length + '→' + y.length + ')')
      return out
    }
    // 목록 안쪽의 목록(예: 시작 설정마다 든 키워드북)까지 내려가 본다. 안쪽이 순서만 바뀐 것이면 아무것도 적지 않는다
    x.forEach((v, i) => notPermutations(v, y[i], path + '[]', out))
    return out
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const a = x as Record<string, unknown>
    const b = y as Record<string, unknown>
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (!ORDER_KEY.test(key)) notPermutations(a[key], b[key], path ? path + '.' + key : key, out)
    return out
  }
  if (plain(x) !== plain(y)) out.push(path)
  return out
}

function cases(body: WorkBody): [string, WorkChanges][] {
  const out: [string, WorkChanges][] = [['제목 고치기', { fields: { title: body.title + MARK } }]]
  if (typeof body.fields.main === 'string' && body.fields.main)
    out.push(['메인 고치기', { fields: { main: body.fields.main + MARK } }])
  if (body.lorebook.length) {
    out.push(['로어북 0번 내용 고치기', { lorebookPatch: [{ index: 0, content: body.lorebook[0].content + MARK }] }])
    const same = body.lorebook.map((e) => ({ ...e }))
    out.push(['로어북 전체 교체(같은 내용, given 없음)', { lorebook: same }])
    out.push([
      '로어북 전체 교체(같은 내용, 제목·키·내용만 줌)',
      { lorebook: same.map((e) => ({ ...e, mode: null, offKeys: [], turnRange: null, offTurnRange: null, given: ['title', 'keys', 'content'] })) }
    ])
    if (body.lorebook.length > 1)
      out.push(['로어북 전체 교체(순서 뒤집기)', { lorebook: [...same].reverse() }])
  }
  if (body.startScenarios.length)
    out.push(['시작 상황 0번 내용 고치기', { startScenarios: [{ index: 0, content: body.startScenarios[0].content + MARK }] }])
  return out
}

describe.skipIf(!ROOT || !existsSync(ROOT))('경우별 저장 본문', () => {
  it('바꾸려던 칸만 바뀌는지', async () => {
    const oldAdapters = OLD && existsSync(OLD)
      ? ((await import(pathToFileURL(join(OLD, 'src/main/works/adapters.ts')).href)) as { workAdapter: typeof workAdapter })
      : null
    const lines = ['# 경우별 저장 본문 (실제 스냅샷)', '', '"안 바꾼 저장" 본문과 견줘 달라진 경로. 바꾼 칸 말고 다른 경로가 보이면 살펴볼 곳이다.', '']
    for (const platform of PLATFORMS) {
      const base = join(ROOT, platform)
      if (!existsSync(base)) continue
      const b = workAdapter(platform)
      const a = oldAdapters?.workAdapter(platform) ?? null
      if (!b.applyChanges || !b.save) continue
      const table = new Map<string, { works: number; errors: Map<string, number>; paths: Map<string, number>; versusOld: Map<string, number> }>()
      const row = (name: string): { works: number; errors: Map<string, number>; paths: Map<string, number>; versusOld: Map<string, number> } => {
        let r = table.get(name)
        if (!r) table.set(name, (r = { works: 0, errors: new Map(), paths: new Map(), versusOld: new Map() }))
        return r
      }
      const bump = (map: Map<string, number>, key: string): void => void map.set(key, (map.get(key) ?? 0) + 1)
      let works = 0
      for (const work of readdirSync(base).filter((n) => statSync(join(base, n)).isDirectory() && !n.includes('.save-report'))) {
        const file = latest(join(base, work))
        if (!file) continue
        let raw: unknown
        let body: WorkBody
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
          body = b.normalize(raw)
        } catch (error) {
          bump(row('(읽기)').errors, String((error as Error).message).slice(0, 40))
          continue
        }
        works++
        const noop = await send(b, work, raw, {})
        const r0 = row('안 바꾼 저장')
        r0.works++
        if (noop.error) bump(r0.errors, noop.error)
        if (a?.applyChanges && a.save) {
          const old = await send(a, work, raw, {})
          if (old.error !== noop.error) bump(r0.versusOld, '오류 옛=' + old.error + ' 새=' + noop.error)
          for (const d of rawDiff(old.sent, noop.sent, 300)) bump(r0.versusOld, strip(d.path) + ' ' + d.kind)
        }
        for (const [name, changes] of cases(body)) {
          const r = row(name)
          r.works++
          const next = await send(b, work, raw, changes)
          if (next.error !== noop.error) bump(r.errors, String(next.error))
          if (name.includes('뒤집기')) {
            // 번호 칸이 없는 목록은 자리로 견줘 전부 달라 보인다. 그래서 "순서만 바뀐 것인지"를 따로 본다
            const bad = new Set(notPermutations(noop.sent, next.sent).map(strip))
            if (!bad.size) bump(r.paths, '순서만 바뀜')
            for (const where of bad) bump(r.paths, '!! 순서 말고도 달라진 곳: ' + where)
          } else
            for (const d of rawDiff(noop.sent, next.sent, 300)) bump(r.paths, strip(d.path) + ' ' + d.kind)
          if (a?.applyChanges && a.save) {
            // 옛 코드는 given을 모른다
            const plain = structuredClone(changes)
            plain.lorebook?.forEach((e) => delete e.given)
            const old = await send(a, work, raw, plain)
            if (old.error !== next.error) bump(r.versusOld, '오류 옛=' + old.error + ' 새=' + next.error)
            for (const d of rawDiff(old.sent, next.sent, 300)) bump(r.versusOld, strip(d.path) + ' ' + d.kind)
          }
        }
      }
      lines.push('## ' + platform + ' (작품 ' + works + '편)', '')
      for (const [name, r] of table) {
        lines.push('### ' + name + ' — ' + r.works + '편')
        if (r.errors.size) lines.push('- 오류: ' + [...r.errors].map(([k, n]) => k + ' ×' + n).join(', '))
        if (name !== '안 바꾼 저장')
          lines.push('- 안 바꾼 저장과 다른 경로: ' + ([...r.paths].sort((p, q) => q[1] - p[1]).slice(0, 14).map(([k, n]) => '`' + k + '` ×' + n).join(', ') || '없음'))
        if (a) lines.push('- 옛 코드와 다른 곳: ' + ([...r.versusOld].sort((p, q) => q[1] - p[1]).slice(0, 14).map(([k, n]) => '`' + k + '` ×' + n).join(', ') || '없음'))
        lines.push('')
      }
    }
    if (OUT) writeFileSync(OUT, lines.join('\n'))
    expect(lines.length).toBeGreaterThan(4)
  })
})
