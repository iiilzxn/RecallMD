# 离线语音模型：本机准备与 CPU 对照测试

日期：2026-09-22。

四个用户下载的压缩包已核对官方发布字节数，并完整读取 bzip2/tar 内容、提取必要权重、成功运行识别。SenseVoice 压缩包及本次下载的原生运行程序还核对了官方 SHA-256。其余三个旧模型发布资产没有提供官方摘要，记录的是本地计算的 SHA-256，不能称为官方哈希校验通过。

原下载文件保持原位。提取结果在工作区的 `speech-lab.local/models/`，运行程序在 `speech-lab.local/runtime/`。`*.local/` 已由现有 `.gitignore` 排除，模型和二进制不会进入源码版本管理。

## 测量条件

- Intel Core i7-14650HX，16 核 / 24 线程；系统可见内存 15.7 GiB。
- sherpa-onnx v1.13.8，Windows x64，CPU provider，每个识别进程 2 个推理线程。
- 使用官方预编译原生 EXE，无 GPU、无 CUDA、无 ASR 网络调用。Python 标准库只用于解压与测量，识别在原生进程中执行。
- 四个模型使用完全相同的三段官方示例：普通话 5.592 秒、英语 7.152 秒、中英混合 10.053 秒。每种组合独立启动进程运行两次，共 24 次，均退出成功。
- 顺序运行，不清空系统文件缓存。模型加载、进程启动计入“整次运行”，原生 CLI 报告的解码时间另列。
- 每 10 毫秒读取 Windows 的进程历史内存峰值。工作集包含驻留物理内存；私有提交量另记。这是单独识别进程的占用，不是 RecallMD 整个应用的内存。
- 没有开启用户麦克风，没有采集用户录音。

## 结果

模型文件大小为本次实际使用的权重及词表总和。MiB = 1024² 字节。

| 模型 | 必要模型文件 | 进程峰值工作集 | 进程峰值私有提交量 | 解码 RTF 中位数 | 整次进程用时中位数 |
|---|---:|---:|---:|---:|---:|
| Zipformer Small 中文 INT8 | 25.38 MiB | 102.12 MiB | 90.89 MiB | 0.0217 | 0.932 秒 |
| Zipformer Small 中英双语 | 57.59 MiB | 129.99 MiB | 116.05 MiB | 0.0226 | 0.905 秒 |
| 流式 Paraformer 中英双语 INT8 | 226.21 MiB | 303.09 MiB | 290.09 MiB | 0.0690 | 1.490 秒 |
| SenseVoice Small INT8 | 228.45 MiB | 331.92 MiB | 337.27 MiB | 0.0362 | 1.283 秒 |

RTF = 解码耗时 / 音频时长。例如 0.02 表示计算吞吐约为音频播放速度的 50 倍。它不包含用户说话、分块等待或语音端点检测时间，不能直接解释为实时字幕延迟。

小型双语 Zipformer 使用官方示例的组合：量化 encoder 和 joiner、非量化 decoder。官方完整包还包含其他精度及分块配置；本次仅保留运行所需文件。四套所选模型共约 537.63 MiB；实验运行程序目录约 60.17 MiB，包含多种命令行工具，不等于未来安装包必须增加同样大小。

详细数据：[OFFLINE_ASR_BASELINE.json](OFFLINE_ASR_BASELINE.json)。本地完整日志及可复查清单在 `speech-lab.local/logs/`、`models.json`、`runtime.json`。

## 选型判断与局限

- 这台机器上，四个模型处理短音频的计算吞吐都快于实时。持续录音、并行运行 RecallMD 和长时间内存稳定性还没有验证。
- 中文小模型对英文片段输出了大量 `<unk>`，不作为中文夹技术英语的默认候选。
- 小型双语 Zipformer 的资源开销最低，适合作为第一轮实时接入候选；Paraformer 和 SenseVoice 保留作对照。
- 各模型在样例转写中都有文本差异。本次样本少、部分音频来自模型自己的示例集，未建立独立人工标注测试集，也没有计算 CER/WER，不能据此给出准确率排行榜。
- 下一轮应使用相同的真实复习口述，覆盖 Redis、epoll、IO、多线程、数字、否定词和思考停顿。SenseVoice 按句/分段识别，接近实时显示还需要分段或重解码策略；文件解码速度不能替代这一体验测试。
- 原生推理可继续接到 Tauri/Rust 后端；此次没有变更应用中的录音、复习或评分流程。离线 ASR 不需要语音 API Key，现有 Jev 评分仍需联网。

## 复现

```powershell
python -X utf8 scripts/asr/prepare.py --downloads 'C:\Users\18937\Downloads' --lab 'D:\RecallMD\speech-lab.local'
python -X utf8 scripts/asr/benchmark.py --lab 'D:\RecallMD\speech-lab.local' --threads 2 --repeats 2
```

准备脚本从官方发布 API 核对文件大小及可用的 SHA-256，检查归档路径，仅提取指定模型文件及示例音频。运行程序固定为已核对摘要的 v1.13.8 Windows x64 CPU 版本。测试脚本隐藏启动原生子进程，有单次超时，并记录失败及完整输出。

来源：[模型发布资产](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)、[原生运行程序 v1.13.8](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8)、[Rust 原生集成](https://k2-fsa.github.io/sherpa/onnx/rust-api/advanced-install.html)。
