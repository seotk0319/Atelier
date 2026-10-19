// AI 태그 도우미 프롬프트. 순수 함수만 두어 Electron 없이 시험할 수 있게 한다.
import type { ChatMessage } from '../llm/openrouter'
import type { TagHelperPart } from '../../shared/tag-helper'

const OUTPUT_RULES = `You turn a Korean description or a reference image into NovelAI V5 (Danbooru) image tags.

Output rules:
- Return ONE single line of lowercase Danbooru tags separated by ", ".
- Use spaces instead of underscores (write "long hair", not "long_hair").
- No headers, no numbering, no explanations, no code fences, no line breaks.
- Do not use weight syntax unless the user explicitly asked for it. If they did, keep it exactly as written.
- Use concrete atomic Danbooru tags. Avoid vague umbrella tags such as "detailed outfit".
- Describe only what is stated, implied, or clearly visible. Do not invent items, colors, or props.
- Characters are adults. Never output child, teen, loli, or underage-coded body tags.
- "girl"/"boy" and "adult woman"/"adult man" belong to the appearance part. Output them ONLY when face, hair, or body tags are also in your output. Clothing-only, pose-only, or background-only output must not contain them.
- If the user adds an extra instruction (for example to leave out a mask), follow it.
- Use only real Danbooru tag names. Do not coin new phrases; pick the closest existing Danbooru tag instead
  (e.g. "light smile" not "slight smile", "holding cup" not "holding coffee", "elevator, indoors" not "in elevator",
  "shrug (clothing)" not "bolero"). The only non-Danbooru tags allowed are the NovelAI anchors "girl", "boy",
  "adult woman", "adult man", and "highly detailed".

`

/** 한글 설명용 용어표 — 그림 분석에는 넣지 않는다 (없는 옷을 끌어오는 일이 있었다) */
const KOREAN_TERMS = `Korean fashion and pose terms (use these Danbooru tags):
로우번/똥머리/올림머리 -> hair bun (add "single hair bun" when one bun); 포니테일 -> ponytail; 단발 -> short hair, bob cut;
앞머리 일자 -> blunt bangs; 옆머리 -> sidelocks; 흰 마스크 -> white mask, mouth mask; 볼레로 -> shrug (clothing);
가디건 -> cardigan; 민소매 -> sleeveless; 밀착/붙는 -> tight clothes or the garment name with "tight";
롱원피스 -> long dress; 슬랙스 -> pants; 니삭스 -> kneehighs; 스타킹 -> pantyhose; 가터 -> garter straps;
살짝 웃는 -> light smile; 뒤돌아보는 -> looking back; 손에 들고 -> holding <item>; 커피 -> holding cup, coffee;
체형 글래머/가슴 큰 -> large breasts; 골반 넓은 -> wide hips; 허리 잘록 -> narrow waist; 하얀 피부 -> pale skin.
`

/** ZK-514 31단계 순서표. 구도·배경은 31번 뒤에 붙는다. */
const SLOT_ORDER = `Tag order (ZK-514). Keep this order; skip slots that have nothing to say.
1 sex: girl, boy
2 character name: proper name if given (e.g. Shiranui Kaya)
3 looking direction: looking at viewer, looking away, looking back
4 role / race / mood: knight, elf, cool
5 situation: battle, night, school, date
6 pose: standing, sitting, kneeling, dynamic pose
7 action: grabbing sword, holding bag, reaching out
8 expression: angry, neutral expression, closed mouth, relaxed eyebrows
9 face: glasses, mask, mole under eye
10 hair (color + length + style + bangs): black hair, long hair, hime cut, blunt bangs, sidelocks
11 upper body: adult woman, medium breasts, fair skin
12 lower body: narrow waist, wide hips, thick thighs, long legs
13 body state: sweat, wet, injured, covered in dust
14 outfit genre: school uniform, armor, maid outfit
15 outfit material: metal, leather, denim, fur trim
16 outfit structure: sailor collar, hooded jacket, pleated
17 top: white shirt, blouse, sweater
18 outer top: navy jacket, coat, cape
19 arm wear: arm guards, detached sleeves
20 hand wear: gloves, fingerless gloves
21 bottoms: black pleated skirt, shorts, pants
22 leg wear: pantyhose, thighhighs, kneehighs
23 main accessory: the single signature accessory
24 hair accessory: hairclip, hair ribbon, hair ornament
25 neck accessory: choker, necklace, scarf
26 shoulder accessory: epaulettes, shoulder armor
27 arm / hand accessory: bracelet, wristband, ring
28 waist accessory: belt, waist bow, sash
29 leg accessory: garter straps, leg ribbon
30 shoes: only when the description asks for shoes or the framing shows feet
31 highly detailed: the closing anchor of the character bundle; output it only when appearance or outfit tags are present
After slot 31: camera and framing (upper body, cowboy shot, full body, from below), then background and lighting (cafe, window, night, warm lighting).

Detail requirements when that part is present:
- Hair needs color + length + style, plus bangs or sidelocks when known.
- Outfit needs specific garments: type, color, length, fit, and material when visible.
- Body needs more than one tag. A single breast-size tag is not enough.
- Keep accessories in their body-part slot (23 main, 24 hair, 25 neck, 26 shoulder, 27 arm/hand, 28 waist, 29 leg).
`

/** 그림에서 뽑을 것 → 해당 슬롯 */
const PART_SCOPE: Record<TagHelperPart, string> = {
  look: 'appearance: slots 1, 2, 9, 10, 11, 12, 13 (sex, name, face, hair, body, body state) plus the adult anchor',
  outfit: 'outfit: slots 14-30 (clothing, accessories, shoes when visible)',
  pose: 'pose and expression: slots 3, 6, 7, 8 (gaze, pose, action, expression)',
  scene:
    'composition and background: slot 5 (situation) plus camera/framing, background and lighting'
}
const PART_ORDER: TagHelperPart[] = ['look', 'outfit', 'pose', 'scene']

const TEXT_TASK =
  `Task: convert ONLY what the Korean description states or clearly implies.
- Do not fill slots the description does not mention. If it only talks about clothes, output only clothing tags; if it only describes a pose, output only pose tags. Never invent hair, body, face, clothes, or background that were not described.
- Order the tags you do output by the slot table below.

` + KOREAN_TERMS

export function normalizeParts(parts: readonly string[] | undefined): TagHelperPart[] {
  const set = new Set((parts ?? []).filter((p): p is TagHelperPart => p in PART_SCOPE))
  return PART_ORDER.filter((p) => set.has(p))
}

function imageTask(parts: TagHelperPart[]): string {
  const chosen = parts.map((p) => '- ' + PART_SCOPE[p]).join('\n')
  const skipped = PART_ORDER.filter((p) => !parts.includes(p))
    .map((p) => '- ' + PART_SCOPE[p])
    .join('\n')
  return (
    'Task: describe the image, but output tags ONLY for these parts:\n' +
    chosen +
    (skipped ? '\nDo NOT output any tag that belongs to these parts:\n' + skipped : '') +
    '\nDescribe only what is clearly visible. Do not guess garments hidden by the framing (no skirt or shoes when only the upper body is shown).' +
    '\nHair itself (color, length, style) is appearance; hair accessories (ribbons, clips) are outfit slot 24.' +
    '\nOrder the tags by the slot table below.\n'
  )
}

export interface TagSystemInput {
  /** 그림 요청이면 뽑을 것. 한글 요청이면 비운다 */
  parts?: TagHelperPart[]
  image: boolean
}

export function tagHelperSystemPrompt(input: TagSystemInput): string {
  const task = input.image ? imageTask(normalizeParts(input.parts)) : TEXT_TASK
  return OUTPUT_RULES + '\n' + task + '\n' + SLOT_ORDER
}

export interface BuildTagMessagesInput {
  /** 한글 설명 (그림 요청이면 비운다) */
  text?: string
  /** data:<mime>;base64,<b64> */
  imageDataUrl?: string
  /** 그림에서 뽑을 것 */
  parts?: TagHelperPart[]
  note?: string
}

function userInstruction(input: BuildTagMessagesInput): string {
  const note = (input.note ?? '').trim()
  const extra = note ? '\n\nExtra instruction from the user: ' + note : ''
  if (input.imageDataUrl) {
    return 'Convert the requested parts of this image into tags.' + extra
  }
  return (
    'Convert this Korean description into tags. Keep every detail that is stated and add nothing else.' +
    extra +
    '\n\nKorean description:\n"""\n' +
    (input.text ?? '').trim() +
    '\n"""'
  )
}

export function buildTagMessages(input: BuildTagMessagesInput): ChatMessage[] {
  const image = !!input.imageDataUrl
  const system = tagHelperSystemPrompt({ image, parts: input.parts })
  const instruction = userInstruction(input)
  if (image) {
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: input.imageDataUrl! } }
        ]
      }
    ]
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: instruction }
  ]
}
