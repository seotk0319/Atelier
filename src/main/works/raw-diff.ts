// 플랫폼 원본 두 개를 통째로 견준다. 저장 뒤 검증(work_save의 raw_check)에 쓴다.
// 공통 모양(WorkBody)만 견주면 연결부가 모르는 칸이 바뀌거나 사라져도 드러나지 않는다.
// 결과에는 경로와 값의 모양(종류·길이)만 싣고 내용은 싣지 않는다.

export interface RawChange {
  /** 예: characters[id=12].lorebook[3].content */
  path: string
  kind: 'changed' | 'added' | 'removed'
  /** 값의 모양. 글이면 "글 120자", 목록이면 "목록 3개" */
  before?: string
  after?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function shape(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return '없음'
  if (typeof v === 'string') return '글 ' + v.length + '자'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return '목록 ' + v.length + '개'
  return '묶음 ' + Object.keys(v as Obj).length + '칸'
}

const ID_KEYS = ['id', '_id', 'idx', 'uuid', 'oid', 'key']
/** 목록의 모든 항목이 같은 이름의 번호 칸을 갖고 그 값이 서로 다르면 그 칸 이름을 돌려준다 */
function idKey(list: unknown[]): string | null {
  if (!list.length || !list.every(isObj)) return null
  for (const key of ID_KEYS) {
    const seen = new Set<string>()
    let ok = true
    for (const item of list as Obj[]) {
      const value = item[key]
      if ((typeof value !== 'string' && typeof value !== 'number') || value === '') {
        ok = false
        break
      }
      seen.add(String(value))
    }
    if (ok && seen.size === list.length) return key
  }
  return null
}

/**
 * 두 원본에서 다른 곳을 모두 돌려준다. 목록은 항목에 번호 칸이 있으면 번호로, 없으면 자리로 짝짓는다.
 * limit을 넘으면 거기서 멈춘다(큰 작품에서 결과가 끝없이 길어지지 않게).
 */
export function rawDiff(a: unknown, b: unknown, limit = 500): RawChange[] {
  const out: RawChange[] = []
  const push = (change: RawChange): boolean => {
    if (out.length < limit) out.push(change)
    return out.length < limit
  }
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length >= limit) return
    if (x === y) return
    if (x === undefined) {
      push({ path, kind: 'added', after: shape(y) })
      return
    }
    if (y === undefined) {
      push({ path, kind: 'removed', before: shape(x) })
      return
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const key = idKey(x) && idKey(x) === idKey(y) ? idKey(x) : null
      if (key) {
        const right = new Map((y as Obj[]).map((item) => [String(item[key]), item]))
        const left = new Set<string>()
        for (const item of x as Obj[]) {
          const id = String(item[key])
          left.add(id)
          walk(item, right.get(id), path + '[' + key + '=' + id + ']')
        }
        for (const [id, item] of right)
          if (!left.has(id)) walk(undefined, item, path + '[' + key + '=' + id + ']')
        // 같은 항목들의 순서만 바뀐 것도 변화다
        const order = (list: Obj[]): string =>
          list
            .map((item) => String(item[key]))
            .filter((id) => left.has(id) && right.has(id))
            .join(',')
        if (order(x as Obj[]) !== order(y as Obj[]))
          push({ path: path + ' (순서)', kind: 'changed' })
        return
      }
      const n = Math.max(x.length, y.length)
      for (let i = 0; i < n; i++) walk(x[i], y[i], path + '[' + i + ']')
      return
    }
    if (isObj(x) && isObj(y)) {
      for (const name of new Set([...Object.keys(x), ...Object.keys(y)]))
        walk(x[name], y[name], path ? path + '.' + name : name)
      return
    }
    push({ path, kind: 'changed', before: shape(x), after: shape(y) })
  }
  walk(a, b, '')
  return out
}

// 서버가 저장할 때마다 스스로 바꾸는 칸(수정 시각·판 번호 등). 이런 칸이 달라진 것은 문제로 치지 않는다.
const SERVER_FIELD =
  /(^|[._])(updated|modified|saved|published|version|revision|rev|etag|checksum|hash)|(At|_at|_dt|Dt|Date|_date|Time|_time|Count|_count|_seconds|_nanoseconds|snapshotId|epoch)$/i
const lastName = (path: string): string =>
  (path.split('.').pop() ?? '').replace(/\[[^\]]*\]/g, '').replace(/ \(순서\)$/, '')

export interface RawCheck {
  /** 서버가 스스로 바꾸는 칸을 빼고 보면 보내려던 원본과 저장된 원본이 같다 */
  same: boolean
  /** 보내려던 것과 다르게 저장된 곳 (앞에서부터 max개) */
  differences: RawChange[]
  /** differences에 싣지 못한 나머지 개수 */
  more: number
  /** 서버가 스스로 바꾸는 칸이 달라진 개수 */
  server_fields: number
  /** 연결부가 "서버가 스스로 다시 만드는 값"이라고 적어 둔 경로(rawIgnore)에서 달라진 개수 */
  ignored: number
  /** 빈 글과 null이 서로 바뀐 칸의 개수 (서버가 빈 글을 null로 저장하는 플랫폼이 있다. 문제로 치지 않는다) */
  empty_swaps: number
}

/** 보내려던 원본(expected)과 저장 뒤 다시 읽은 원본(actual)을 견준 결과 */
export function rawCheck(
  expected: unknown,
  actual: unknown,
  max = 30,
  ignore: RegExp[] = []
): RawCheck {
  const every = rawDiff(expected, actual)
  const skip = (change: RawChange): boolean => ignore.some((re) => re.test(change.path))
  const all = every.filter((change) => !skip(change))
  const server = all.filter((change) => SERVER_FIELD.test(lastName(change.path)))
  // 빈 글 ↔ null: 2026-11-13 에덴 실제 저장에서 확인(빈 subtitle·scenario_settings를 null로 돌려준다)
  const EMPTY = new Set(['글 0자', 'null'])
  const emptySwap = (change: RawChange): boolean =>
    change.kind === 'changed' && EMPTY.has(change.before ?? '') && EMPTY.has(change.after ?? '')
  const rest = all.filter(
    (change) => !SERVER_FIELD.test(lastName(change.path)) && !emptySwap(change)
  )
  return {
    same: rest.length === 0,
    differences: rest.slice(0, max),
    more: Math.max(0, rest.length - max),
    server_fields: server.length,
    ignored: every.length - all.length,
    empty_swaps: all.filter((change) => !SERVER_FIELD.test(lastName(change.path)) && emptySwap(change))
      .length
  }
}
