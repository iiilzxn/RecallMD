# 本地语音输入：Paraformer 中英双语 FP32

当前只保留 `paraformer-bilingual-fp32`。设置页展示一张状态卡，复习页直接录音，不再提供模型切换、INT8 入口或多模型对比。

## 使用

打开「设置 → 语音输入」，检查 Paraformer 已就绪，按需选择麦克风和 3 / 10 / 30 分钟录音上限。「试录一段」可检查麦克风及转写效果，最近 8 条试录文字只保留在当前页面内存中。

在复习页点击「语音回答」或按 F2 开始录音，再按 F2 或点击「结束并转写」。识别文字追加到已有答案；核对后再自行提交评分。语音本身离线运行，无需 API Key。Jev 评分仍按原有设置在确认提交时联网。

本次保留用户已选的麦克风、语音开关和录音上限；本机上限仍为 3 分钟。达到上限后自动结束并转写，不会自动提交答案。

## 模型与配置

原始下载包 `sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2` 为 1,047,319,737 字节（约 999 MiB），其中包含不同精度文件。应用仅使用：

| 文件 | 字节数 |
| --- | ---: |
| encoder.onnx | 636348877 |
| decoder.onnx | 228464044 |
| tokens.txt | 75756 |

实际所需文件合计约 825 MiB；压缩包体积、模型文件体积与运行内存是不同指标。不会加载 `*.int8.onnx`。

本机模型目录为 `D:/RecallMD/speech-lab.local/models/paraformer-bilingual-fp32`。模型根目录可以选择它的父目录、官方包名目录或具体模型目录。启动录音前核对固定文件名与预期字节数。

`speech-settings.json` 位于应用配置目录（Windows 通常为 `%APPDATA%/com.recallmd.desktop/`）。旧版保存的七个其他模型 ID 仅作为迁移别名读取，统一转为 Paraformer FP32；保存时写入唯一的正式 ID，并保留开关、目录、设备与时长。不再包含其他模型的加载分支。

准备工具同样仅处理 Paraformer FP32，复用用户已有压缩包：

```powershell
python scripts/asr/prepare_fp32.py --downloads C:/Users/18937/Downloads --lab speech-lab.local
```

该命令查询官方压缩包信息并校验、提取文件，不会下载其他模型或准备原生 SDK。`prepare.py` 也已收敛为同一模型；`benchmark.py` 仅测量本模型包内的官方 WAV。

## 运行边界

原生后端为 `cpal 0.18.2`、`sherpa-onnx 1.13.8` 和对应 ONNX Runtime，CPU 推理使用 2 个线程。录音结束后转写，当前没有实时字幕。每次只运行一个录音或转写任务。

音频只在内存中处理，不写录音文件、不上传语音。回调仅混声、计量音量和投递有界队列，工作线程重采样到 16 kHz。CPAL 的可恢复通知不会误判为设备断开；真正的错误保留底层分类。取消、切题和离开页面会丢弃迟到的结果。

## 2026-09-26 验证与清理

- `pnpm typecheck` 通过；前端 238 项测试通过、2 项跳过。
- 语音 Rust 单元测试 12 项通过，另显式运行并通过 Paraformer 原生转写 smoke 测试，使用官方中英混合 WAV，不打开用户麦克风。
- `speech_check` 返回 `modelsReady: 1`，输入设备枚举正常，不打开麦克风。
- Release 构建成功，`speech-preview.local/RecallMD.exe`、`RecallMD-FP32.exe`、`RecallMD-NewIcon.exe` 更新为同一程序；EXE 与构建产物哈希一致，四份运行时 DLL 一致。
- 已从实际模型目录移走其他七个模型目录及过往失败下载残留。批量直接删除遭自动审批拦截，系统回收站返回权限错误，最终采用可恢复归档：`D:/RecallMD/retired-speech-models.local/2026-09-26`，约 1043 MiB。软件不读取归档目录；这一步没有释放其磁盘占用。用户 Downloads 中的原始压缩包保留。
- 当前模型清单 `speech-lab.local/models.json` / `models-fp32.json` 仅登记 Paraformer FP32。

## 构建

```powershell
# SDK 已准备好时直接使用本地缓存
$env:SHERPA_ONNX_ARCHIVE_DIR = (Resolve-Path 'speech-lab.local').Path
pnpm tauri build --no-bundle
```

需要首次准备 SDK 时使用 `scripts/asr/prepare_native.py`。成品不需要 Python、Rust 或 CUDA。分发时 EXE 和四份原生 DLL 必须位于同一目录。

过去的四模型对比结果保留在 `OFFLINE_ASR_BASELINE.md/json` 作为历史实验记录，不代表当前提供的模型选项。
