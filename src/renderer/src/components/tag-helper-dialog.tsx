import { Check, Copy, ImagePlus, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  TagHelperImageRequest,
  TagHelperItem,
  TagHelperPart,
  TagHelperResult,
  TagHelperTextRequest
} from '@shared/tag-helper'
import { TAG_HELPER_IMAGE_MAX, TAG_HELPER_PARTS, TAG_HELPER_TEXT_MAX } from '@shared/tag-helper'
import { cn } from '../lib/utils'
import { IMAGE_PATHS_MIME, droppedImagePaths, hasImageDrop } from '../lib/image-drag'
import { fileToBase64 } from '../lib/metadata-request'
import { useLayoutStore } from '../stores/layout-store'
import { useTagHelperStore, type TagHelperImage } from '../stores/tag-helper-store'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Segmented, SegmentedItem } from './ui/segmented'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

/** 파일 드래그 중에는 아직 그림인지 몰라 item.type으로 확인한다. */
function isImageDrag(e: React.DragEvent): boolean {
  if (e.dataTransfer.types.includes(IMAGE_PATHS_MIME)) return true
  return Array.from(e.dataTransfer.items).some(
    (item) => item.kind === 'file' && (item.type === '' || IMAGE_TYPES.includes(item.type))
  )
}

async function imageFromFile(file: File): Promise<TagHelperImage | null> {
  if (!IMAGE_TYPES.includes(file.type)) return null
  const base64 = await fileToBase64(file)
  if (base64.length > TAG_HELPER_IMAGE_MAX) {
    toast('그림이 너무 커요. 조금 작은 그림으로 넣어주세요.', 'error')
    return null
  }
  return { base64, mime: file.type }
}

/** AI 태그 도우미 — 앱 어디서든 한 번만 마운트한다. */
export function TagHelperDialog(): React.JSX.Element {
  const isOpen = useTagHelperStore((s) => s.isOpen)
  const seq = useTagHelperStore((s) => s.seq)
  const close = useTagHelperStore((s) => s.close)
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[86vh] w-[calc(100%-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">AI 태그 도우미</DialogTitle>
        {isOpen && <TagHelperBody key={seq} />}
      </DialogContent>
    </Dialog>
  )
}

function TagHelperBody(): React.JSX.Element {
  const initial = useTagHelperStore.getState()
  const close = useTagHelperStore((s) => s.close)
  const openSettingsAt = useLayoutStore((s) => s.openSettingsAt)
  const [tab, setTab] = useState<'image' | 'text'>(initial.image ? 'image' : 'text')
  const [parts, setParts] = useState<TagHelperPart[]>(initial.parts)
  const [image, setImage] = useState<TagHelperImage | null>(initial.image)
  const [text, setText] = useState(initial.text)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // 넣은 그림·탭이 바뀔 때마다 1씩 — 뽑는 사이 그림을 바꾸면 앞 그림의 태그를 새 그림 옆에 보이지(적용하지) 않는다
  const inputRev = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const [items, setItems] = useState<TagHelperItem[]>([])
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void window.nais
      .invoke('openrouter:status', undefined)
      .then((status) => {
        if (live) setHasKey(status.hasKey)
      })
      .catch(() => {
        if (live) setHasKey(false)
      })
    return () => {
      live = false
    }
  }, [])

  // Ctrl+V로 복사한 그림 — 창 어디에 포커스가 있어도 받는다 (글 붙여넣기는 그대로 둔다).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        IMAGE_TYPES.includes(f.type)
      )
      if (!file) return
      e.preventDefault()
      setTab('image')
      void takeFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // takeFile은 setter만 쓰므로 처음 렌더의 것을 그대로 써도 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tags = items.map((item) => item.tag).join(', ')

  async function takeFile(file: File): Promise<void> {
    const next = await imageFromFile(file)
    if (!next) return
    inputRev.current++
    setImage(next)
    setItems([])
    setFeedback(null)
  }

  async function takePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const res = await window.nais.invoke('images:readForSource', { filePath: paths[0] })
    if ('error' in res) {
      toast(res.error, 'error')
      return
    }
    inputRev.current++
    setImage({ base64: res.base64, mime: mimeForPath(paths[0]) })
    setItems([])
    setFeedback(null)
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    if (!hasImageDrop(e) || !isImageDrag(e)) return
    const file = Array.from(e.dataTransfer.files).find((f) => IMAGE_TYPES.includes(f.type))
    const paths = droppedImagePaths(e)
    e.preventDefault()
    setDragOver(false)
    if (!file && paths.length === 0) {
      toast('PNG, JPEG, WEBP 그림만 넣을 수 있어요.', 'info')
      return
    }
    if (file) await takeFile(file)
    else await takePaths(paths)
  }

  async function run(): Promise<void> {
    if (busy) return
    const trimmedNote = note.trim()
    setFeedback(null)
    setItems([])
    setBusy(true)
    const rev = inputRev.current
    try {
      let res: TagHelperResult
      if (tab === 'image') {
        if (!image) {
          setFeedback({ ok: false, message: '그림을 먼저 넣어주세요.' })
          return
        }
        const request: TagHelperImageRequest = {
          imageBase64: image.base64,
          mime: image.mime,
          parts,
          ...(trimmedNote ? { note: trimmedNote } : {})
        }
        res = await window.nais.invoke('tagHelper:fromImage', request)
      } else {
        if (!text.trim()) {
          setFeedback({ ok: false, message: '설명을 먼저 적어주세요.' })
          return
        }
        const request: TagHelperTextRequest = {
          text: text.trim(),
          ...(trimmedNote ? { note: trimmedNote } : {})
        }
        res = await window.nais.invoke('tagHelper:fromText', request)
      }
      if (rev !== inputRev.current) return
      const nextItems =
        res.items?.length > 0
          ? res.items
          : res.tags
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => ({ tag, known: true }))
      setItems(nextItems)
      setFeedback({ ok: res.ok, message: res.message })
    } catch {
      setFeedback({ ok: false, message: '태그를 뽑지 못했어요. 잠시 뒤 다시 시도해주세요.' })
    } finally {
      setBusy(false)
    }
  }

  function apply(how: 'replace' | 'append'): void {
    if (!initial.onApply || !tags) return
    initial.onApply(tags, how)
    close()
  }

  async function copy(): Promise<void> {
    if (!tags) return
    try {
      await navigator.clipboard.writeText(tags)
      toast('태그를 복사했어요', 'success')
    } catch {
      toast('복사하지 못했어요. 아래 줄을 직접 골라 주세요.', 'error')
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-4">
        <span className="grid size-8 place-items-center rounded-full bg-accent-soft text-accent">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">AI 태그 도우미</p>
          <p className="mt-0.5 text-[12px] text-faint">
            한글 설명이나 그림을 NAI 태그 한 줄로 바꿔요.
          </p>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void takeFile(file)
          e.target.value = ''
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 no-scrollbar">
        <Segmented
          value={tab}
          onValueChange={(v) => {
            if (!v) return
            inputRev.current++
            setTab(v as 'image' | 'text')
          }}
        >
          <SegmentedItem value="image">그림에서 뽑기</SegmentedItem>
          <SegmentedItem value="text">한글로 쓰기</SegmentedItem>
        </Segmented>

        {hasKey === false && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2">
            <p className="min-w-0 flex-1 text-[12px] text-muted">
              OpenRouter 키가 없어서 지금은 태그를 뽑을 수 없어요.
            </p>
            <Button
              size="sm"
              variant="tint"
              onClick={() => {
                close()
                window.setTimeout(() => openSettingsAt('ai-helper'), 150)
              }}
            >
              설정 열기
            </Button>
          </div>
        )}

        {tab === 'image' ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] font-semibold text-muted">뽑을 것</span>
              {TAG_HELPER_PARTS.map((part) => {
                const on = parts.includes(part.id)
                return (
                  <button
                    key={part.id}
                    aria-pressed={on}
                    onClick={() =>
                      setParts((current) =>
                        on
                          ? current.length > 1
                            ? current.filter((p) => p !== part.id)
                            : current
                          : TAG_HELPER_PARTS.map((p) => p.id).filter(
                              (id) => id === part.id || current.includes(id)
                            )
                      )
                    }
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors',
                      on ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted hover:text-ink'
                    )}
                  >
                    {on && <Check size={12} />}
                    {part.label}
                  </button>
                )
              })}
            </div>
            <div
              className={cn(
                'mt-2 flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors',
                dragOver ? 'border-accent bg-accent-soft/40' : 'border-line bg-paper'
              )}
              onDragOver={(e) => {
                if (!hasImageDrop(e) || !isImageDrag(e)) return
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void handleDrop(e)}
            >
              {image ? (
                <>
                  <img
                    src={`data:${image.mime};base64,${image.base64}`}
                    alt="넣은 그림"
                    className="h-28 max-w-full rounded-md border border-line object-contain"
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        inputRev.current++
                        setImage(null)
                      }}
                    >
                      <X size={13} /> 빼기
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                      <ImagePlus size={13} /> 다른 그림
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <ImagePlus size={20} className="text-faint" />
                  <p className="text-[13px] text-muted">그림을 끌어다 놓거나 Ctrl+V로 붙여넣어요</p>
                  <p className="text-[11px] text-faint">PNG · JPEG · WEBP</p>
                  <Button variant="outline" onClick={() => fileRef.current?.click()}>
                    파일 고르기
                  </Button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={TAG_HELPER_TEXT_MAX}
              rows={5}
              placeholder="예) 검은 머리 로우번, 흰 마스크, 회색 밀착 민소매 롱원피스에 볼레로 가디건"
              aria-label="태그로 바꿀 설명"
              className="mt-3 block w-full resize-none rounded-lg border border-line bg-paper p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent/40"
            />
            <p className="mt-1.5 text-[11px] text-faint">
              적은 것만 태그로 바꿔요. 옷만 적으면 옷 태그만, 자세만 적으면 자세 태그만 나와요.
            </p>
          </>
        )}

        <Input
          className="mt-2 h-9 rounded-lg"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="추가 지시 (선택)"
          aria-label="추가 지시"
        />

        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-[11px] text-faint">DeepSeek V4.1 Flash · 한 번에 1원 안팎</p>
          <Button
            variant="accent"
            className="gap-1.5"
            loading={busy}
            disabled={hasKey === false || (tab === 'image' ? !image : !text.trim())}
            onClick={() => void run()}
          >
            <Sparkles size={14} /> 태그 뽑기
          </Button>
        </div>

        {feedback && (
          <p className={cn('mt-2 text-[12px]', feedback.ok ? 'text-accent' : 'text-danger')}>
            {feedback.message}
          </p>
        )}

        {items.length > 0 && (
          <div className="mt-3">
            <div className="flex flex-wrap gap-1.5">
              {items.map((item, index) => (
                <button
                  key={`${item.tag}-${index}`}
                  onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                  title={item.known ? '누르면 빼요' : '로컬 태그 DB에 없는 태그예요'}
                  className={cn(
                    'inline-flex h-7 items-center rounded-md border px-2 font-mono text-[12px] transition-colors',
                    item.known
                      ? 'border-line bg-surface-2 text-ink hover:bg-surface'
                      : 'border-dashed border-line bg-surface text-muted hover:bg-surface-2'
                  )}
                >
                  {item.tag}
                  <X size={11} className="ml-1 shrink-0 text-faint" />
                </button>
              ))}
            </div>
            <textarea
              readOnly
              value={tags}
              rows={3}
              aria-label="뽑은 태그 한 줄"
              className="mt-2 block w-full resize-none rounded-lg border border-line bg-paper p-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none"
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
        {initial.targetLabel && (
          <span className="min-w-0 truncate text-[11px] text-faint">
            넣을 곳 · {initial.targetLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" disabled={!tags} onClick={() => void copy()}>
            <Copy size={13} /> 복사
          </Button>
          {initial.onApply ? (
            <>
              <Button variant="default" disabled={!tags} onClick={() => apply('replace')}>
                덮어쓰기
              </Button>
              <Button variant="accent" disabled={!tags} onClick={() => apply('append')}>
                뒤에 붙이기
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
