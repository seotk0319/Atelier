/** 씬 시드 정규화: 0~4294967295 정수만, 아니면 null (메인 시드 설정을 따른다) */
export const SCENE_SEED_MAX = 4294967295

export function normalizeSceneSeed(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= SCENE_SEED_MAX ? n : null
}

/** 씬 생성 시드. 씬에 시드가 있으면 그 값에서, 같은 씬 여러 장은 +offset으로 민다 */
export function sceneSeedFrom(seed: number, offset: number): number {
  return (seed + offset) % (SCENE_SEED_MAX + 1)
}
