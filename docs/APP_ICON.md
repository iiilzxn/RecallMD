# RecallMD 图标 v2

使用内置 image_gen 生成，并使用内置工具做了一次透明边缘清理。没有使用 CLI/API 图像生成。

设计：苔绿色圆角方块、暖白色展开的书页和回卷折角，呼应 Markdown 笔记与主动回忆。图形不依赖文字，适用于浅色和深色界面。

## 文件与接入

- 最终生成源图：`src-tauri/icons/recallmd-v2/master-final.png`（1254 × 1254，RGBA）。
- Windows 多尺寸图标：`src-tauri/icons/recallmd-v2/icon.ico`，含 16、24、32、48、64、256 像素图层。
- 桌面其他尺寸及 ICNS：同目录，由 Tauri 官方图标命令转换。
- 软件侧栏及启动页：`src/assets/recallmd-v2.png`。
- 浏览器页签：`public/recallmd-v2.ico`。
- 原有默认图标文件仍保留；`tauri.conf.json` 指向新的版本目录。

已通过类型检查、前端和 Windows 原生构建；侧栏图标已检查浅色、深色显示。还直接读取了编译后 EXE 的 Windows 图标资源，确认 6 个尺寸的图像内容与新 ICO 完全一致。

本机新图标测试版：`D:/RecallMD/speech-preview.local/RecallMD-NewIcon.exe`。

重新生成平台尺寸：

```powershell
pnpm tauri icon src-tauri/icons/recallmd-v2/master-final.png --output src-tauri/icons/recallmd-v2
```

## 初始生成提示词

```text
Use case: logo-brand.
Asset type: a finished desktop application icon for RecallMD, a calm Markdown notebook and active-recall learning application. This is ONE final square app-icon asset, not a presentation, not a mockup and not a grid of alternatives.

Design a distinctive minimal emblem combining an open book with a quietly returning page, suggesting knowledge revisited and remembered. The central mark consists of two broad warm-ivory paper shapes with a clean dark-green central crease; the right page has a single elegant curved folded edge that subtly suggests a returning loop. Keep it unified as one bold book/page symbol, not a collection of separate tiny symbols. Refined, memorable, friendly and professional, like a carefully designed independent productivity app.

Palette and container: a deep muted forest/sage green rounded-square tile, subtly shaded from #638571 at the upper left to #355C47 at the lower right, matching a warm-paper and moss-green desktop interface. Emblem in warm ivory #F7F5EA, with at most one very restrained pale-sage secondary paper layer. Nearly flat graphic construction, exceptionally clean edges, broad shapes and ample negative space. No glossy plastic, no heavy extrusion, no grain or texture. Straight-on, no perspective.

Composition: centered on a square 1024 x 1024 canvas. The rounded square occupies about 94 percent of the canvas, with only a small transparent margin. Truly transparent alpha outside the rounded square, not a checkerboard picture and not a white background. The paper emblem is visually balanced and occupies roughly 62 percent of the tile width. Make the silhouette immediately legible at 16, 24, 32 and 48 pixels. Strong contrast; no hairline strokes or fine decorative details.

No words, letters, initials, numbers, watermark, charts, bars, microphones, brains, light bulbs or unrelated objects. No surrounding scene, device frame, caption, large outside shadow or alternate versions. Deliver only the clean finished application icon.
```

## 边缘清理提示词

```text
Use case: background-extraction / precise-object-edit.
Edit the supplied app icon only to clean its transparency and edge quality. Keep exactly the existing green rounded-square tile, ivory open-book emblem, folded upper-right page, placement, proportions and palette.

There are unwanted detached green speckles above the rounded square and tiny bright fringes around its outer contour. Remove every detached speck and all stray marks outside the rounded-square silhouette. The entire area outside the single rounded-square tile must be truly fully transparent alpha, with a perfectly clean anti-aliased rounded contour. Do not render a black or white background or a checkerboard graphic. Do not add a shadow. Do not add any detail or alter the book shape.

Preserve the current icon design. Return only one clean, square production-ready app icon PNG on genuine transparency.
```
