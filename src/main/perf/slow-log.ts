// 앱 본체(메인 프로세스)를 오래 붙잡은 일을 한 줄씩 남기는 기록 (<userData>/perf/slow.jsonl).
// 본체가 붙잡혀 있는 동안에는 창·클릭·다른 요청이 모두 멈추므로, "어디가 느린가"의 근거가 된다.
// Electron을 모른다 (파일 경로만 받는다). 요청 내용은 담지 않고 이름과 시간만 쓴다.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SlowEntry {
  at: string
  /** 화면이 부른 요청 이름, 또는 '(loop)' = 요청과 무관하게 본체가 멈춘 구간 */
  name: string
  /** 본체를 붙잡은 시간 (ms) */
  blockedMs: number
  /** 응답까지 걸린 전체 시간 (ms). 기다리기만 한 시간(네트워크 등)이 들어간다 */
  totalMs?: number
}

export interface SlowLog {
  /** 요청 하나를 감싼다: 본체를 붙잡은 시간이 기준을 넘으면 남긴다. 결과와 오류는 그대로 돌려준다 */
  wrap<T>(name: string, run: () => T | Promise<T>): T | Promise<T>
  /** 요청과 무관한 멈춤을 남긴다 */
  stall(blockedMs: number): void
  /** 밀린 파일 쓰기가 끝날 때까지 (테스트용) */
  flush(): Promise<void>
}

export function createSlowLog(options: {
  file: string
  /** 이 시간(ms) 이상 본체를 붙잡은 것만 남긴다 */
  thresholdMs?: number
  /** 파일이 이 크기를 넘으면 .1로 넘기고 새로 쓴다 */
  maxBytes?: number
  now?: () => number
}): SlowLog {
  const threshold = options.thresholdMs ?? 50
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const now = options.now ?? (() => performance.now())
  let chain: Promise<void> = Promise.resolve()

  const write = (entry: SlowEntry): void => {
    chain = chain
      .then(async () => {
        await mkdir(dirname(options.file), { recursive: true })
        const size = await stat(options.file).then(
          (s) => s.size,
          () => 0
        )
        if (size > maxBytes) await rename(options.file, options.file + '.1')
        await appendFile(options.file, JSON.stringify(entry) + '\n')
      })
      .catch(() => undefined)
  }
  const round = (ms: number): number => Math.round(ms * 10) / 10

  return {
    wrap(name, run) {
      const started = now()
      let result
      try {
        result = run()
      } catch (error) {
        const blocked = now() - started
        if (blocked >= threshold)
          write({ at: new Date().toISOString(), name, blockedMs: round(blocked) })
        throw error
      }
      const blocked = now() - started
      if (blocked < threshold) return result
      const entry: SlowEntry = { at: new Date().toISOString(), name, blockedMs: round(blocked) }
      if (result instanceof Promise) {
        const done = (): void => write({ ...entry, totalMs: round(now() - started) })
        result.then(done, done)
      } else {
        write(entry)
      }
      return result
    },
    stall(blockedMs) {
      if (blockedMs >= threshold)
        write({ at: new Date().toISOString(), name: '(loop)', blockedMs: round(blockedMs) })
    },
    flush() {
      return chain
    }
  }
}

/**
 * 요청과 무관하게 본체가 멈춘 구간을 잡는다: 일정 간격으로 깨어나, 늦게 깨어난 만큼을 멈춘 시간으로 본다.
 * 반환값을 부르면 멈춘다.
 */
export function watchStalls(
  log: SlowLog,
  options: { everyMs?: number; minMs?: number; now?: () => number } = {}
): () => void {
  const every = options.everyMs ?? 500
  const min = options.minMs ?? 200
  const now = options.now ?? (() => performance.now())
  let last = now()
  const timer = setInterval(() => {
    const t = now()
    const late = t - last - every
    last = t
    if (late >= min) log.stall(late)
  }, every)
  timer.unref?.()
  return () => clearInterval(timer)
}
