import type { RemoteStamp } from '@shared/remote-view'
import { workDateTime } from '@shared/inbox-works'
import { agoText } from '../lib/works-table'

/** 맥미니에서 받아 온 내용 옆의 표시. 끊겼으면 마지막으로 받은 시각을 함께 보여 준다. */
export function RemoteMark({
  stamp,
  now
}: {
  stamp: RemoteStamp | undefined
  now: number
}): React.JSX.Element | null {
  if (!stamp) return null
  const at = workDateTime(stamp.receivedAt)
  return stamp.stale ? (
    <span className="text-[12px] tabular-nums text-bad" title={'마지막으로 받은 시각 ' + at}>
      <span className="font-semibold">맥미니 끊김</span> · {at} 받음
    </span>
  ) : (
    <span className="text-[12px] tabular-nums text-faint" title={at}>
      맥미니 · {agoText(stamp.receivedAt, now)} 받음
    </span>
  )
}
