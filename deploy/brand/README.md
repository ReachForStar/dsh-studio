# Background artwork

English | [中文](README.zh.md)

Product background for the Web app, painted onto the body with `background-size: cover` and `background-attachment: fixed` (see `packages/client/ui-polish/src/client/background-runtime.ts`). The plugin's stylesheet makes the structural surfaces transparent while an image is active, so the artwork sits behind the sidebar, the transcript column, and the details panel. The upload cap in `packages/client/ui-polish/src/background-settings.ts` is 10MB.

## Constraints the layout imposes

- **Everything is a text background.** Sidebar, transcript column, and details panel are translucent, so no region of the image is reliably free of copy. The image itself must stay light and quiet.
- **Light theme first.** Copy uses dark text, so the ground must stay high-key: overall mean luminance at or above 88%, dark pixels kept to a fraction of a percent, and a low local standard deviation in every band.
- **Cropping.** `cover` on a fixed attachment crops to the viewport, so keep every focal element inside the central 80% of the frame and leave the outermost band empty.
- **Opaque neighbours.** Menus, dialogs, cards, code blocks, and the Excalidraw canvas keep their own fills; the artwork never has to carry meaning there.

## Composition

| Element | Placement |
| --- | --- |
| 启明 (router) | six-ray star lantern, upper centre-left |
| 天权 / 瑶光 / 天梁 (three seats) | characters or star clusters along the right edge and lower right |
| 星域 (star domain) | hair-thin pale-blue constellation lines linking them |
| 国风 | rice-paper grain, ruyi cloud ribbons along top and bottom edges |
| 星辰 | sparse tiny white stars with a soft glow |

Palette: paper white `#F7FAFD` → pale mist `#E3EDF9` → light blue `#C9DDF2`, line accent `#7FA8D9`, no dark fills.

## Prompts

Star map without figures, 16:9 (`--size 2K --ratio 16:9` yields 2624×1472):

```text
A serene Chinese ink-wash star map painted on pale rice paper, extremely light and airy, dominant palette pale blue and off-white. A faint six-ray star lantern glows softly above the centre-left as the hub; three small delicate star clusters sit upper-right, right-middle and lower-right, linked by hair-thin pale blue constellation lines; sparse tiny white stars with soft glow; subtle ruyi cloud ribbons along the top and bottom edges; faint silk paper grain. Made as a UI wallpaper: very low contrast, high-key, no dark areas, even soft lighting, empty quiet centre band, no text, wide 16:9, elegant minimal Chinese style
```

Anime-style figures confined to the right edge, the variant with the calmest transcript band:

```text
A very light Chinese ink-wash UI wallpaper on white rice paper. Four small anime-style celestial figures in flowing hanfu are confined to a narrow band along the right edge and the bottom-right corner, together covering under a quarter of the frame: a guide figure holding a glowing six-ray lantern, a sword-bearing scholar, a starlit archer and a scroll-bearing strategist. They are drawn only with thin pale blue-grey lines and soft pale blue watercolour washes, garments nearly white, absolutely no black ink, no dark hair, no heavy shading, faces calm and simple. Hair-thin pale blue constellation lines run between them, sparse tiny white stars, faint ruyi cloud ribbons along the top and bottom edges, delicate silk paper grain. The middle-left two thirds of the frame stays almost empty and quiet. High-key light-theme wallpaper: extremely low local contrast, wide empty areas, pale blue accents, no text, wide 16:9, minimal elegant Chinese anime aesthetic
```

Negative prompt:

```text
text, letters, watermark, logo, signature, dark background, night sky, heavy contrast, dense star field, busy texture, high-frequency noise, hard-edged silhouettes, saturated colours, gold foil, black ink splashes, dark hair, black outlines, cluttered centre, vignette, frame, border
```

## Candidates

Measured with Pillow on the eight-bit greyscale conversion. Bands are the sidebar (left 15%), the transcript column (centre 32–68%), and the details panel (right 15%).

| File | Mean | Darkest 0.1% | Pixels < 128 | Sidebar | Transcript | Details |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-background-qiming-16x9.png` | 224.6 (88.1%) | 156 | 0.015% | sd 6.0, p5 224 | sd 7.1, p5 208 | sd 7.9, p5 217 |
| `dsh-background-qiming-characters-16x9.png` | 231.9 (90.9%) | 62 | 0.78% | sd 8.3, p5 216 | sd 15.4, p5 220 | sd 31.5, p5 144 |
| `dsh-background-qiming-characters-pale-16x9.png` | 242.7 (95.2%) | 9 | 1.69% | sd 11.3, p5 230 | sd 27.9, p5 217 | sd 41.8, p5 130 |
| `dsh-background-qiming-characters-edge-16x9.png` | 242.0 (94.9%) | 13 | 1.46% | sd 5.2, p5 238 | sd 1.2, p5 252 | sd 44.4, p5 109 |

`characters-edge` leaves the transcript column effectively blank and keeps the figures on the right edge, where the details panel supplies its own tint. The figure variants carry thin line work, so their local contrast in that column is higher than the star-map variant; use the star map when the details panel stays open over content that must stay maximally legible.
