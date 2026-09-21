# 背景图

[English](README.md) | 中文

Web 应用的产品背景图，通过 `background-size: cover` 与 `background-attachment: fixed` 画在 body 上（见 `packages/client/ui-polish/src/client/background-runtime.ts`）。背景图生效期间该插件的样式表会把结构面改为透明，因此图会垫在侧边栏、转录列与详情面板之下。上传上限见 `packages/client/ui-polish/src/background-settings.ts`，为 10MB。

## 布局带来的约束

- **处处都是文字背景。** 侧边栏、转录列与详情面板都是半透明，没有任何一块区域可以假定没有正文，所以图本身必须保持明亮、安静。
- **按浅色主题设计。** 正文是深色文字，因此底色必须高调：全图平均亮度不低于 88%，深色像素只占千分之几，各分区的局部标准差都要低。
- **会被裁切。** `cover` 加固定附着会按视口裁切，因此所有主体元素要落在画面中央 80% 以内，最外一圈留空。
- **邻居是不透明的。** 菜单、对话框、卡片、代码块与 Excalidraw 画布都有各自的填色，无需靠背景图承担信息。

## 构图

| 元素 | 位置 |
| --- | --- |
| 启明（路由者） | 六芒宫灯星，中央偏左、上三分之一 |
| 天权 / 瑶光 / 天梁（三席） | 国风人物或星簇，沿右缘与右下排布 |
| 星域 | 极细的淡蓝连线把它们连成星座 |
| 国风 | 宣纸纹理，上下边缘的如意云纹 |
| 星辰 | 稀疏的细小白色星点，带柔光 |

配色：纸白 `#F7FAFD` → 轻雾 `#E3EDF9` → 浅蓝 `#C9DDF2`，线条点缀 `#7FA8D9`，不使用深色块。

## 提示词

无人物星图，16:9（`--size 2K --ratio 16:9` 得到 2624×1472）：

```text
A serene Chinese ink-wash star map painted on pale rice paper, extremely light and airy, dominant palette pale blue and off-white. A faint six-ray star lantern glows softly above the centre-left as the hub; three small delicate star clusters sit upper-right, right-middle and lower-right, linked by hair-thin pale blue constellation lines; sparse tiny white stars with soft glow; subtle ruyi cloud ribbons along the top and bottom edges; faint silk paper grain. Made as a UI wallpaper: very low contrast, high-key, no dark areas, even soft lighting, empty quiet centre band, no text, wide 16:9, elegant minimal Chinese style
```

人物压在右缘的版本，转录列最干净：

```text
A very light Chinese ink-wash UI wallpaper on white rice paper. Four small anime-style celestial figures in flowing hanfu are confined to a narrow band along the right edge and the bottom-right corner, together covering under a quarter of the frame: a guide figure holding a glowing six-ray lantern, a sword-bearing scholar, a starlit archer and a scroll-bearing strategist. They are drawn only with thin pale blue-grey lines and soft pale blue watercolour washes, garments nearly white, absolutely no black ink, no dark hair, no heavy shading, faces calm and simple. Hair-thin pale blue constellation lines run between them, sparse tiny white stars, faint ruyi cloud ribbons along the top and bottom edges, delicate silk paper grain. The middle-left two thirds of the frame stays almost empty and quiet. High-key light-theme wallpaper: extremely low local contrast, wide empty areas, pale blue accents, no text, wide 16:9, minimal elegant Chinese anime aesthetic
```

负向提示词：

```text
text, letters, watermark, logo, signature, dark background, night sky, heavy contrast, dense star field, busy texture, high-frequency noise, hard-edged silhouettes, saturated colours, gold foil, black ink splashes, dark hair, black outlines, cluttered centre, vignette, frame, border
```

## 候选

数值用 Pillow 对成品文件的八位灰度换算测得。分区为侧边栏（左侧 15%）、转录列（中央 32–68%）与详情面板（右侧 15%）。

| 文件 | 平均亮度 | 最暗 0.1% | 低于 128 占比 | 侧边栏 | 转录列 | 详情 |
| --- | --- | --- | --- | --- | --- | --- |
| `dsh-background-qiming-16x9.png` | 224.6（88.1%） | 156 | 0.015% | sd 6.0，p5 224 | sd 7.1，p5 208 | sd 7.9，p5 217 |
| `dsh-background-qiming-characters-16x9.png` | 231.9（90.9%） | 62 | 0.78% | sd 8.3，p5 216 | sd 15.4，p5 220 | sd 31.5，p5 144 |
| `dsh-background-qiming-characters-pale-16x9.png` | 242.7（95.2%） | 9 | 1.69% | sd 11.3，p5 230 | sd 27.9，p5 217 | sd 41.8，p5 130 |
| `dsh-background-qiming-characters-edge-16x9.png` | 242.0（94.9%） | 13 | 1.46% | sd 5.2，p5 238 | sd 1.2，p5 252 | sd 44.4，p5 109 |

`characters-edge` 把转录列留成近乎空白，人物全部压在右缘——那里有详情面板自带的底色。人物版含细线描边，该列的局部对比高于纯星图版；若详情面板常开且其上的内容必须最好读，选纯星图那版。
