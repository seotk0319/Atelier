import type Database from 'better-sqlite3'
import type { DatabaseSync } from 'node:sqlite'

/**
 * better-sqlite3는 Electron용 빌드라 vitest(Node)에서 못 연다.
 * 같은 파일을 node:sqlite로 열고 앱 코드가 쓰는 better-sqlite3 API만 흉내 낸다.
 */
export function sqliteShim(raw: () => DatabaseSync): Database.Database {
  const api = {
    exec(sql: string) {
      raw().exec(sql)
      return api
    },
    prepare(sql: string) {
      const st = raw().prepare(sql)
      return {
        run: (...p: never[]) => st.run(...p),
        get: (...p: never[]) => st.get(...p),
        all: (...p: never[]) => st.all(...p)
      }
    },
    pragma(source: string, options?: { simple?: boolean }) {
      if (source.includes('=')) {
        raw().exec(`PRAGMA ${source}`)
        return []
      }
      const row = raw().prepare(`PRAGMA ${source}`).get() as Record<string, unknown>
      return options?.simple ? Object.values(row)[0] : [row]
    },
    transaction<T>(fn: () => T) {
      const run = (): T => {
        raw().exec('BEGIN')
        try {
          const r = fn()
          raw().exec('COMMIT')
          return r
        } catch (e) {
          raw().exec('ROLLBACK')
          throw e
        }
      }
      return Object.assign(run, { immediate: run, deferred: run })
    }
  }
  return api as unknown as Database.Database
}
