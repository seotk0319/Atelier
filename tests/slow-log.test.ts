import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSlowLog } from '../src/main/perf/slow-log'

let dir: string
let file: string
const lines = (): { name: string; blockedMs: number; totalMs?: number }[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-slow-'))
  file = join(dir, 'perf', 'slow.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** now()가 부를 때마다 정해진 값을 차례로 돌려준다 */
const clock = (...times: number[]): (() => number) => {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

describe('slow log', () => {
  it('기준보다 빨리 끝난 요청은 남기지 않고 결과를 그대로 돌려준다', async () => {
    const log = createSlowLog({ file, now: clock(0, 10) })
    expect(log.wrap('fast', () => 7)).toBe(7)
    await log.flush()
    expect(lines()).toEqual([])
  })

  it('본체를 붙잡은 요청은 이름과 시간만 남긴다', async () => {
    const log = createSlowLog({ file, now: clock(0, 120) })
    expect(log.wrap('images:list', () => 'x')).toBe('x')
    await log.flush()
    const [entry] = lines()
    expect(entry.name).toBe('images:list')
    expect(entry.blockedMs).toBe(120)
    expect(Object.keys(entry).sort()).toEqual(['at', 'blockedMs', 'name'])
  })

  it('기다리는 시간이 긴 요청은 붙잡은 시간이 짧으면 남기지 않는다', async () => {
    const log = createSlowLog({ file, now: clock(0, 5) })
    await log.wrap('network', () => new Promise((r) => setTimeout(() => r(1), 20)))
    await log.flush()
    expect(lines()).toEqual([])
  })

  it('붙잡은 뒤 기다리기까지 한 요청은 전체 시간도 남긴다', async () => {
    const log = createSlowLog({ file, now: clock(0, 80, 300) })
    await log.wrap('mixed', () => Promise.resolve(1))
    await new Promise((r) => setTimeout(r, 0))
    await log.flush()
    expect(lines()).toMatchObject([{ name: 'mixed', blockedMs: 80, totalMs: 300 }])
  })

  it('오류는 그대로 던지고, 붙잡은 시간이 길었으면 남긴다', async () => {
    const log = createSlowLog({ file, now: clock(0, 90) })
    expect(() =>
      log.wrap('boom', () => {
        throw new Error('x')
      })
    ).toThrow('x')
    await log.flush()
    expect(lines()).toMatchObject([{ name: 'boom', blockedMs: 90 }])
  })

  it('요청과 무관한 멈춤은 (loop)로 남기고, 파일이 크면 .1로 넘긴다', async () => {
    const log = createSlowLog({ file, maxBytes: 10 })
    log.stall(10)
    log.stall(400)
    await log.flush()
    expect(lines()).toMatchObject([{ name: '(loop)', blockedMs: 400 }])
    writeFileSync(file, 'x'.repeat(50) + '\n')
    log.stall(500)
    await log.flush()
    expect(existsSync(file + '.1')).toBe(true)
    expect(lines()).toMatchObject([{ name: '(loop)', blockedMs: 500 }])
  })
})
