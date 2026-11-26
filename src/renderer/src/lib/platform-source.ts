import { useEffect, useState } from 'react'

/**
 * 알림·작품 화면의 내용을 어디서 가져오는지.
 * 'direct' = 이 PC가 크롬 로그인으로 직접 모음, 'macmini' = 맥미니에서 받음, null = 이 프로필에는 그 화면이 없음.
 */
export type PlatformSource = 'direct' | 'macmini' | null

let asked: Promise<PlatformSource> | null = null

/** 켜져 있는 동안 바뀌지 않으므로 한 번만 묻는다 */
export function platformSource(): Promise<PlatformSource> {
  asked ??= window.nais
    .invoke('app:profile', undefined)
    .then((v) => v.platforms)
    .catch(() => null)
  return asked
}

/** 답을 받기 전에는 null (화면 없음으로 본다) */
export function usePlatformSource(): PlatformSource {
  const [source, setSource] = useState<PlatformSource>(null)
  useEffect(() => {
    let alive = true
    void platformSource().then((v) => {
      if (alive) setSource(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return source
}
