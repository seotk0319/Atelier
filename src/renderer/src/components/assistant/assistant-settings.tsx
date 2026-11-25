import { BookText, FileUp, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ASSISTANT_MODELS, type AssistantStatus } from '@shared/assistant'
import { useAssistantStore } from '../../stores/assistant-store'
import { toast } from '../../stores/toast-store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { Switch } from '../ui/switch'

/** 설정 > AI 비서: Claude 키, 모델, 지침 문서, 명령 버튼 표시 */
export function AssistantSection(): React.JSX.Element {
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  // 저장된 키를 다른 키로 바꿀 때 입력칸을 다시 연다
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null)

  const apply = (next: AssistantStatus): void => {
    setStatus(next)
    useAssistantStore.setState({ status: next })
  }
  useEffect(() => {
    void window.nais.invoke('assistant:status', undefined).then(apply)
  }, [])

  async function saveKey(): Promise<void> {
    if (!key.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await window.nais.invoke('assistant:setKey', { key })
      setNote(result)
      if (result.ok) {
        setKey('')
        setEditing(false)
        apply(await window.nais.invoke('assistant:status', undefined))
      }
    } finally {
      setBusy(false)
    }
  }

  async function importGuide(): Promise<void> {
    const result = await window.nais.invoke('assistant:importGuide', undefined)
    apply(result)
    if (result.message) toast(result.message, 'success')
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] leading-relaxed text-faint">
        화면 아래 명령 바(Ctrl+K)에서 말로 시키면 Claude가 씬 프리셋을 정리하거나 프롬프트를 써
        줘요. 앱을 바꾸는 일은 계획을 먼저 보여 주고, 실행을 눌러야 적용돼요.
      </p>

      <div className="rounded-xl border border-line p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            <Sparkles size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">
              {status?.claudeReady ? 'Claude 연결됨' : 'Claude API 키가 필요해요'}
            </p>
            <p className="mt-0.5 text-[12px] text-faint">이 PC에만 암호화해 저장돼요.</p>
          </div>
          {status?.claudeReady && !editing && (
            <Button size="sm" onClick={() => setEditing(true)}>
              키 바꾸기
            </Button>
          )}
        </div>
        {(!status?.claudeReady || editing) && (
          <div className="mt-3 flex gap-2">
            <Input
              type="password"
              value={key}
              placeholder="sk-ant-..."
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
            />
            <Button variant="accent" loading={busy} onClick={() => void saveKey()}>
              저장
            </Button>
          </div>
        )}
        {note && (
          <p className={'mt-2 text-[12px] ' + (note.ok ? 'text-accent' : 'text-danger')}>
            {note.message}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[13px] text-ink">모델</p>
          <p className="mt-0.5 text-[12px] text-faint">
            Sonnet이 정리 계획을 더 정확하게 세워요. 프롬프트만 쓸 거면 Haiku도 충분해요.
          </p>
        </div>
        <Segmented
          value={status?.model ?? 'sonnet'}
          onValueChange={(v) =>
            v &&
            void window.nais
              .invoke('assistant:setConfig', { model: v as 'sonnet' | 'haiku' })
              .then(apply)
          }
        >
          <SegmentedItem value="sonnet">{ASSISTANT_MODELS.sonnet.label}</SegmentedItem>
          <SegmentedItem value="haiku">{ASSISTANT_MODELS.haiku.label}</SegmentedItem>
        </Segmented>
      </div>

      <div>
        <p className="text-[13px] text-ink">작업 지침</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-faint">
          AI가 늘 따라야 할 규칙 문서를 넣어 두면 매번 같이 읽어요. 타이포 프롬프트 규칙, 확정
          색·배치 같은 것을 담아 두면 돼요.
        </p>
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-line p-3">
          <BookText size={16} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-ink">{status?.guideName ?? '없음'}</p>
            {!!status?.guideChars && (
              <p className="text-[11.5px] text-faint">{status.guideChars.toLocaleString()}자</p>
            )}
          </div>
          <Button size="sm" onClick={() => void importGuide()}>
            <FileUp size={13} />
            {status?.guideChars ? '바꾸기' : '파일 불러오기'}
          </Button>
          {!!status?.guideChars && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="지침 지우기"
              onClick={() =>
                void window.nais.invoke('assistant:setConfig', { guide: null }).then(apply)
              }
            >
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[13px] text-ink">화면 아래 AI 비서 버튼</p>
          <p className="mt-0.5 text-[12px] text-faint">꺼도 Ctrl+K로 열 수 있어요</p>
        </div>
        <Switch
          checked={status?.showDock ?? true}
          onCheckedChange={(v) =>
            void window.nais.invoke('assistant:setConfig', { showDock: v }).then(apply)
          }
        />
      </div>
    </div>
  )
}
