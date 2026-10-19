// AI 태그 도우미 프롬프트. 순수 함수만 두어 Electron 없이 시험할 수 있게 한다.
import type { ChatMessage } from '../llm/openrouter'
import type { TagHelperMode } from '../../shared/tag-helper'

const OUTPUT_RULES = `You turn a Korean description or a reference image into NovelAI V5 (Danbooru) image tags.

Output rules:
- Return ONE single line of lowercase Danbooru tags separated by ", ".
- Use spaces instead of underscores (write "long hair", not "long_hair").
- No headers, no numbering, no explanations, no code fences, no line breaks.
- Do not use weight syntax unless the user explicitly asked for it. If they did, keep it exactly as written.
- Use concrete atomic Danbooru tags. Avoid vague umbrella tags such as "detailed outfit".
- Describe only what is stated, implied, or clearly visible. Do not invent items, colors, or props.
- Characters are adults. For a female character always include "girl" plus an adult body anchor such as "adult woman". Never output child, teen, loli, or underage-coded body tags.
- If the user adds an extra instruction (for example to leave out a mask), follow it.
- Use only real Danbooru tag names. Do not coin new phrases; pick the closest existing Danbooru tag instead
  (e.g. "light smile" not "slight smile", "holding cup" not "holding coffee", "elevator, indoors" not "in elevator",
  "shrug (clothing)" not "bolero"). The only non-Danbooru tags allowed are the NovelAI anchors "girl", "boy",
  "adult woman", "adult man", and "highly detailed".

Korean fashion and pose terms (use these Danbooru tags):
로우번/똥머리/올림머리 -> hair bun (add "single hair bun" when one bun); 포니테일 -> ponytail; 단발 -> short hair, bob cut;
앞머리 일자 -> blunt bangs; 옆머리 -> sidelocks; 흰 마스크 -> white mask, mouth mask; 볼레로 -> shrug (clothing);
가디건 -> cardigan; 민소매 -> sleeveless; 밀착/붙는 -> tight clothes or the garment name with "tight";
롱원피스 -> long dress; 슬랙스 -> pants; 니삭스 -> kneehighs; 스타킹 -> pantyhose; 가터 -> garter straps;
살짝 웃는 -> light smile; 뒤돌아보는 -> looking back; 손에 들고 -> holding <item>; 커피 -> holding cup, coffee;
체형 글래머/가슴 큰 -> large breasts; 골반 넓은 -> wide hips; 허리 잘록 -> narrow waist; 하얀 피부 -> pale skin.
`

const CHARACTER = `Mode: character. Output the full fixed character design in exactly this 31-slot order. Fill every slot the description supports; skip a slot only when nothing is implied. Keep the order even when a slot is skipped. Slot 31 is always last.

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
30 shoes: optional, skip by default; loafers, boots, sneakers only when the description asks for shoes or the framing shows feet
31 highly detailed (always last)

Detail requirements:
- Hair needs color + length + style, plus bangs or sidelocks when known.
- Outfit needs specific garments: type, color, length, fit, and material when visible.
- Body needs more than one tag. A single breast-size tag is not enough.
- Keep accessories in their body-part slot (23 main, 24 hair, 25 neck, 26 shoulder, 27 arm/hand, 28 waist, 29 leg).
`

const OUTFIT = `Mode: outfit. Output only clothing and accessories, in slots 14-29 order:
14 outfit genre, 15 material, 16 structure, 17 top, 18 outer top, 19 arm wear, 20 hand wear, 21 bottoms, 22 leg wear, 23 main accessory, 24 hair accessory, 25 neck accessory, 26 shoulder accessory, 27 arm/hand accessory, 28 waist accessory, 29 leg accessory.
Write detailed garment tags: type, color, length, fit, and material when visible (e.g. "white sailor collar blouse", "black pleated skirt", "brown leather belt"). Skip empty slots. Do not output face, hair, body shape, pose, expression, background, or quality tags.
`

const SCENE = `Mode: scene. Output only scene tags: pose, action, expression, gaze, camera and framing, background, and lighting.
Examples: sitting, crossing legs, holding cup, smile, looking at viewer, upper body, cowboy shot, from below, depth of field, cafe, window, night, warm lighting, sunbeam.
Do not output character appearance, hair, body shape, or clothing. Do not output "highly detailed" or other quality tags.
`

export const TAG_HELPER_OUTPUT_RULES = OUTPUT_RULES

export const TAG_HELPER_MODE_INSTRUCTIONS: Record<TagHelperMode, string> = {
  character: CHARACTER,
  outfit: OUTFIT,
  scene: SCENE
}

export function tagHelperSystemPrompt(mode: TagHelperMode): string {
  return OUTPUT_RULES + '\n\n' + (TAG_HELPER_MODE_INSTRUCTIONS[mode] ?? CHARACTER)
}

export interface BuildTagMessagesInput {
  mode: TagHelperMode
  /** 한글 설명 (그림 요청이면 비운다) */
  text?: string
  /** data:<mime>;base64,<b64> */
  imageDataUrl?: string
  note?: string
}

function userInstruction(input: BuildTagMessagesInput): string {
  const note = (input.note ?? '').trim()
  const extra = note ? '\n\nExtra instruction from the user: ' + note : ''
  if (input.imageDataUrl) {
    return 'Describe the visible character or scene in the image and convert it into tags.' + extra
  }
  return (
    'Convert this Korean description into tags. Keep every detail that is stated.' +
    extra +
    '\n\nKorean description:\n"""\n' +
    (input.text ?? '').trim() +
    '\n"""'
  )
}

export function buildTagMessages(input: BuildTagMessagesInput): ChatMessage[] {
  const system = tagHelperSystemPrompt(input.mode)
  const instruction = userInstruction(input)
  if (input.imageDataUrl) {
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: input.imageDataUrl } }
        ]
      }
    ]
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: instruction }
  ]
}
