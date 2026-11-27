import { Images, X } from 'lucide-react'
import { useState } from 'react'
import type { BaseRef, Scene, ScenePreset } from '@shared/types'
import {
  sceneOrPresetRefs,
  BASE_REF_DEFAULT_STRENGTH,
  BASE_REF_DEFAULT_TYPE,
  BASE_REF_MAX,
  BASE_REF_TYPE_CHOICES,
  baseRefFileName,
  baseRefTypeLabel
} from '@shared/base-refs'
import { thumbnailUrl } from '../lib/constants'
import { cn } from '../lib/utils'
import { toast } from '../stores/toast-store'
import { useScenesStore } from '../stores/scenes-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Segmented, SegmentedItem } from './ui/segmented'

/**
 * 머리줄의 기준 레퍼 표시. 프리셋 것을 따르는 씬이면 「· 프리셋」을 붙인다.
 * 없으면 표시하지 않는다 (만들 때는 각 화면의 「기준 레퍼」 단추나 메뉴로).
 */
export function BaseRefChip({
  count,
  fromPreset,
  onClick,
  className
}: {
  count: number
  fromPreset?: boolean
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-full bg-accent/12 px-2.5 text-[12px] font-medium text-accent hover:bg-accent/25',
        className
      )}
      title={
        fromPreset
          ? '프리셋 기준 레퍼를 따라요 — 이 씬을 뽑을 때 실려요. 눌러서 씬만 바꾸기'
          : '이 씬(프리셋)을 뽑을 때 실리는 레퍼 — 눌러서 바꾸기·지우기'
      }
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Images size={12} /> 기준 레퍼 {count}
      {fromPreset && <span className="font-normal text-accent/70">· 프리셋</span>}
    </button>
  )
}

/**
 * 기준 레퍼 바꾸기·지우기. V5 기준이라 종류(캐릭터 / 캐릭터&스타일 / 의상)와 강도(0~5)만 둔다.
 * inherited: 씬 칸이 비어 프리셋 것을 따르고 있을 때 그 목록 (씬 대화상자에서만).
 */
export function BaseRefDialog({
  title,
  refs,
  inherited,
  onSave,
  onClose
}: {
  title: string
  refs: BaseRef[] | null
  inherited?: BaseRef[] | null
  onSave: (refs: BaseRef[] | null) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<BaseRef[]>(refs ?? [])
  // 강도 입력은 글자로 들고 있다가 저장할 때 숫자로 바꾼다 (지우고 다시 칠 수 있게)
  const [strengths, setStrengths] = useState<string[]>((refs ?? []).map((r) => String(r.strength)))
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    const { paths } = await window.nais.invoke('baseRefs:pick', undefined)
    if (paths.length === 0) return
    if (paths.length > BASE_REF_MAX)
      toast(`기준 레퍼는 ${BASE_REF_MAX}장까지라 앞 ${BASE_REF_MAX}장만 넣어요`, 'info')
    // 바꾸기: 고른 그림으로 목록을 새로 채운다. 종류·강도는 첫 줄 값(없으면 캐릭터 2.5)을 이어 쓴다.
    const type = rows[0]?.refType ?? BASE_REF_DEFAULT_TYPE
    const strength = Number(strengths[0] ?? BASE_REF_DEFAULT_STRENGTH)
    const st = Number.isFinite(strength) ? strength : BASE_REF_DEFAULT_STRENGTH
    const next = paths
      .slice(0, BASE_REF_MAX)
      .map((filePath) => ({ filePath, refType: type, strength: st }))
    setRows(next)
    setStrengths(next.map((r) => String(r.strength)))
  }

  const removeAt = (i: number): void => {
    setRows((prev) => prev.filter((_, j) => j !== i))
    setStrengths((prev) => prev.filter((_, j) => j !== i))
  }

  const save = async (list: BaseRef[] | null): Promise<void> => {
    setBusy(true)
    try {
      if (await onSave(list)) onClose()
    } finally {
      setBusy(false)
    }
  }

  const commit = (): void => {
    const list: BaseRef[] = []
    for (let i = 0; i < rows.length; i++) {
      const st = Number(strengths[i])
      if (!strengths[i]?.trim() || !Number.isFinite(st) || st < 0 || st > 5) {
        toast('강도는 0부터 5 사이 숫자예요', 'error')
        return
      }
      list.push({ ...rows[i], strength: st })
    }
    void save(list.length ? list : null)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg p-4">
        <DialogTitle className="mb-1">기준 레퍼 — {title}</DialogTitle>
        <p className="mb-3 text-[12px] text-muted">
          이 씬을 뽑거나 다시 뽑을 때(예약 포함) 실려요. 실리는 동안 레퍼 창에서 켜 둔 레퍼는
          빠져요. 레퍼가 실리면 장마다 Anlas가 들어요.
        </p>

        {rows.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-3 py-5 text-center text-[12px] text-faint">
            {inherited?.length
              ? `씬 기준 레퍼 없음 — 프리셋 기준 레퍼 ${inherited.length}장을 따라요`
              : '기준 레퍼 없음'}
          </div>
        )}

        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {rows.map((r, i) => {
            const known = BASE_REF_TYPE_CHOICES.some((c) => c.type === r.refType)
            return (
              <div
                key={r.filePath + i}
                className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5"
              >
                <img
                  src={thumbnailUrl(r.filePath)}
                  className="size-10 shrink-0 rounded bg-surface-2 object-cover"
                  alt=""
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-ink" title={r.filePath}>
                    {baseRefFileName(r.filePath)}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <Segmented
                      size="sm"
                      value={known ? r.refType : ''}
                      onValueChange={(v) =>
                        v &&
                        setRows((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, refType: v as BaseRef['refType'] } : x
                          )
                        )
                      }
                    >
                      {BASE_REF_TYPE_CHOICES.map((c) => (
                        <SegmentedItem key={c.type} value={c.type}>
                          {c.label}
                        </SegmentedItem>
                      ))}
                    </Segmented>
                    {!known && (
                      <span className="text-[11px] text-faint">{baseRefTypeLabel(r.refType)}</span>
                    )}
                  </div>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                  강도
                  <Input
                    className="h-7 w-14 px-1.5 text-center tabular-nums"
                    inputMode="decimal"
                    value={strengths[i] ?? ''}
                    onChange={(e) =>
                      setStrengths((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                  />
                </label>
                <button
                  className="grid size-6 shrink-0 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
                  title="빼기"
                  onClick={() => removeAt(i)}
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => void pick()} disabled={busy}>
            바꾸기
          </Button>
          {(refs?.length ?? 0) > 0 && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void save(null)}
              title={inherited !== undefined ? '지우면 프리셋 기준 레퍼를 따라요' : undefined}
            >
              지우기
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button variant="accent" onClick={commit} disabled={busy}>
            저장
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 씬 머리줄(씬 상세·선별)의 기준 레퍼: 있으면 표시(프리셋 것이면 「· 프리셋」), 없으면 작은 「기준 레퍼」 단추.
 * 누르면 이 씬의 기준 레퍼를 바꾸거나 지운다 (지우면 프리셋 것을 따른다).
 */
export function SceneBaseRefControl({ scene }: { scene: Scene }): React.JSX.Element {
  const preset = useScenesStore((s) => s.presets.find((p) => p.id === scene.presetId))
  const setSceneBaseRefs = useScenesStore((s) => s.setSceneBaseRefs)
  const [open, setOpen] = useState(false)
  const effective = sceneOrPresetRefs(scene.baseRefs, preset?.baseRefs)
  return (
    <>
      {effective ? (
        <BaseRefChip
          count={effective.refs.length}
          fromPreset={effective.from === 'preset'}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 gap-1"
          title="이 씬을 뽑을 때마다 실을 레퍼"
          onClick={() => setOpen(true)}
        >
          <Images size={13} /> 기준 레퍼
        </Button>
      )}
      {open && (
        <BaseRefDialog
          key={scene.id}
          title={scene.name}
          refs={scene.baseRefs}
          inherited={preset?.baseRefs ?? null}
          onSave={(refs) => setSceneBaseRefs(scene.id, refs)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** 프리셋 기준 레퍼 대화상자 (씬 탭 머리줄·더 보기에서 연다) */
export function PresetBaseRefDialog({
  preset,
  onClose
}: {
  preset: ScenePreset
  onClose: () => void
}): React.JSX.Element {
  const setPresetBaseRefs = useScenesStore((s) => s.setPresetBaseRefs)
  return (
    <BaseRefDialog
      title={`${preset.name} (프리셋)`}
      refs={preset.baseRefs}
      onSave={(refs) => setPresetBaseRefs(preset.id, refs)}
      onClose={onClose}
    />
  )
}
