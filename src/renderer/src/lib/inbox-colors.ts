// Separated hues, one per platform. The previous palette repeated blue, teal and lilac, so three
// pairs of platforms were not distinguishable at any dot size. Uumai and Chatple take brown and slate.
export const PLATFORM_COLORS: Record<string, string> = {
  crack: '#d95d3e',
  neko: '#d99b1f',
  genit: '#8aa320',
  elyn: '#4ca455',
  babe: '#17a398',
  eden: '#3f8fd6',
  rplay: '#3b4fb8',
  teapot: '#8a5fd6',
  luna: '#d65b9e',
  uumai: '#a6683c',
  chatple: '#6b7f99'
}
// The raw hues are fine as bars but too light to read as small text. Mixing toward the
// theme's ink darkens them on light themes and lightens them on dark ones, so the label
// clears 4.5:1 in both without a second palette.
export const platformTone = (platform: string): string =>
  'color-mix(in oklab, ' + PLATFORM_COLORS[platform] + ' 60%, var(--ink))'
