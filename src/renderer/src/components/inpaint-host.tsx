import { useGenerationStore } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useScenesStore } from '../stores/scenes-store'
import { MaskEditor } from './mask-editor'

/** 전역 인페인트 마스크 에디터 — App에 1회 배치. 어느 이미지 우클릭이든 여기서 뜬다 */
export function InpaintHost(): React.JSX.Element | null {
  const target = useGenerationStore((s) => s.inpaintTarget)
  const confirm = useGenerationStore((s) => s.confirmInpaint)
  const cancel = useGenerationStore((s) => s.cancelInpaint)

  // 인페인트 확정 = 소스·마스크를 세팅한 뒤 즉시 1장 예약하고, 예약되면 소스를 비운다
  async function handleConfirm(maskBase64: string, strength?: number): Promise<void> {
    confirm(maskBase64, strength)
    const gen = useGenerationStore.getState()
    if (!gen.source) return
    // 요청은 generate/generateOne 안에서 첫 await 전에 소스를 읽어 담는다
    const sceneId = useScenesStore.getState().selectedId
    const inSceneTab = useLayoutStore.getState().centerMode === 'scene'
    let enqueued = false
    try {
      enqueued =
        inSceneTab && sceneId != null
          ? await useScenesStore.getState().generateOne(sceneId)
          : await gen.generate()
    } catch {
      enqueued = false // 예약이 실패하면 소스를 남겨 다시 시도할 수 있게 한다
    }
    if (enqueued) useGenerationStore.getState().setSource(null)
  }

  if (!target) return null
  return (
    <MaskEditor
      imageBase64={target.base64}
      width={target.width}
      height={target.height}
      confirmLabel="인페인트"
      onCancel={cancel}
      onConfirm={handleConfirm}
    />
  )
}
