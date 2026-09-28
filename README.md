# RecallMD

本地 Markdown 编辑器与主动回忆工具。用普通标题组织笔记，将小节纳入复习，再通过 FSRS 间隔重复安排下一次回忆。

当前版本：**0.3.1**。当前桌面实现面向 **Windows x64**，采用 Tauri 2、React、TypeScript 和 Rust。

## 主要功能

- **Markdown 写作与阅读**：CodeMirror 编辑器、Markdown 预览、代码高亮和 Mermaid 图表。
- **基于笔记的复习**：以小节标题作为题目、直属正文作为答案，无需额外维护卡片模板；支持学习新内容、到期复习和统计。
- **FSRS 调度**：揭示原文后选择 Again / Hard / Good / Easy，安排后续学习。
- **可选 Jev 智能打分**：在笔记预览中添加得分点，提交答案后查看逐点评分；未设得分点时仅对照原文。最终复习评级由用户选择。
- **离线语音输入**：通过 Paraformer 中英双语 FP32 模型在本机转写，支持在复习页按 F2 开始或结束录音。
- **本地数据管理**：Markdown 文件保存正文，知识库内的 `.recallmd/` 保存学习记录与元数据，支持备份、恢复和文件冲突处理。

## 基本使用

1. 打开一个本地笔记文件夹，用 Markdown 标题拆分知识点。
2. 在应用中保存笔记，或对已有文件执行「纳入复习」。应用会写入用于识别复习块的隐藏 HTML 注释。
3. 从「学习新内容」开始学习；之后通过「今日待复习」继续回忆。
4. 根据小节标题作答，揭示原文核对，再选择复习评级。
5. 如需智能打分，在笔记预览的小节标题旁添加得分点，并在设置中配置 Jev；如需语音回答，先准备下文所述模型。

普通编辑与复习可离线使用。Jev 需要 TypeSafe API Key 和网络连接，会发送本题题目、得分点及提交的答案；密钥保存在 Windows 凭据管理器中。语音识别在本机运行，录音不上传。

## 开发环境

- Windows x64，MSVC C++ 构建工具及 Windows SDK。
- Node.js 与 pnpm；仓库记录的开发基线为 Node.js 22.18.0、pnpm 10.15.0。
- Rust MSVC 工具链；`src-tauri/Cargo.toml` 声明的最低版本为 1.98.1。
- Microsoft Edge WebView2 Runtime。
- Python 3.11 或以上，用于准备语音 SDK 和模型；安装后的应用不需要 Python。

依赖版本以 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock` 为准。以下命令均在仓库根目录的 PowerShell 中执行。

### 获取源码与安装依赖

```powershell
git clone git@github.com:iiilzxn/RecallMD.git
cd RecallMD
pnpm install --frozen-lockfile
```

### 浏览器界面预览

```powershell
pnpm dev
```

打开 `http://localhost:5173`。开发服务器注入模拟宿主，适合预览界面；真实文件读写、凭据存储和语音能力需要桌面环境验证。

### 桌面开发

首次运行前准备固定版本的原生语音 SDK。准备脚本会联网下载并校验官方归档，将所需 DLL 放入 `src-tauri/resources/speech-runtime/`。

```powershell
python scripts/asr/prepare_native.py
$env:SHERPA_ONNX_ARCHIVE_DIR = (Resolve-Path 'speech-lab.local').Path
pnpm tauri dev
```

即使暂时不使用语音输入，原生构建也需要上述 SDK 和 DLL。模型文件只在实际使用语音识别时需要。

### 准备离线语音模型

从 [sherpa-onnx 官方模型发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) 获取 `sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2`，放入用户下载目录，再执行：

```powershell
python scripts/asr/prepare_fp32.py --downloads "$env:USERPROFILE/Downloads" --lab speech-lab.local
```

脚本复用已有压缩包，并联网获取官方校验信息。应用使用 `encoder.onnx`、`decoder.onnx` 和 `tokens.txt`，合计约 825 MiB；模型与原生运行时均不存入 Git。完成后在「设置 → 语音输入」选择 `speech-lab.local/models/paraformer-bilingual-fp32` 对应的绝对路径。详情见 [本地语音说明](docs/LOCAL_SPEECH.md)。

### 验证与打包

```powershell
# 前端检查、测试与构建
pnpm typecheck
pnpm test
pnpm build

# 已按上述步骤准备原生 SDK 后，执行 Rust 测试和桌面打包
$env:SHERPA_ONNX_ARCHIVE_DIR = (Resolve-Path 'speech-lab.local').Path
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

前端构建输出为 `dist/`；桌面安装包输出为 `src-tauri/target/release/bundle/nsis/`。当前配置生成简体中文 NSIS 安装包并内嵌 WebView2 离线安装器，打包时可能需要联网获取构建资源。语音模型需单独准备。安装包与构建缓存由 `.gitignore` 排除。

普通测试不调用真实 Jev API；标记为忽略的真实 API 测试需单独显式运行。前端性能测试可通过 `pnpm test:perf` 执行。

## 仓库结构

```text
src/                 React 界面、Markdown 引擎、复习调度与 IPC
src-tauri/           Rust 桌面宿主、持久化、Jev 与语音后端
tests/               前端测试与固定样例
src-tauri/tests/     Rust 集成测试
scripts/             开发预览、图标及语音资源准备工具
docs/                设计、验证记录与发行说明
```

`main` 保存合并后的代码，`release` 用于整理待合并的发布内容。提交源码时保留两个依赖锁文件；本机 `.env`、`*.local`、`.recallmd/`、依赖目录、模型和构建产物均应留在 Git 之外。知识库的 `.recallmd/` 包含学习记录，应通过应用备份功能另行备份。

## 更多文档

- [v0.3.1 发行说明](docs/RELEASE_NOTES_v0.3.1.md)
- [Jev 智能打分](docs/JEV_GRADING.md)
- [本地语音输入](docs/LOCAL_SPEECH.md)
- [新用户引导](docs/ONBOARDING.md)
- [产品与技术设计](docs/PROJECT_DESIGN.md)

`docs/` 中也保留了早期设计与实验记录；当前功能以代码及最新发行说明为准。
