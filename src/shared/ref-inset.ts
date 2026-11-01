/**
 * V5 레퍼런스 인셋 공용 값. V5에는 캐릭터 레퍼런스가 없어서, 켜 둔 레퍼런스를 가로 캔버스 왼쪽 칸에 넣고
 * 오른쪽만 인페인트한다. 레퍼런스의 강도 슬라이더가 V5에서는 참고 칸 크기가 된다.
 */
export const INSET_MIN_SHARE = 0.3
export const INSET_MAX_SHARE = 0.5

/** 레퍼런스 강도(0~1) → 캔버스에서 참고 칸이 차지하는 몫 (0.3~0.5). 기본 0.6 → 0.42 */
export function insetShare(strength: number): number {
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0.6
  return INSET_MIN_SHARE + (INSET_MAX_SHARE - INSET_MIN_SHARE) * s
}
