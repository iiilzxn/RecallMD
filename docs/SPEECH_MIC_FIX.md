# 麦克风误报断开修复（2026-09-22）

## 原因与复现

旧版本在 CPAL 错误回调中忽略了错误类型，统一写入「录音设备已断开或发生错误」并停止采集。

CPAL 同一回调也传递可恢复通知。对用户当前默认麦克风的 5 秒本地检查结果如下（不保留音频，不转写）：

```json
{"sampleRate":48000,"channels":2,"sampleFormat":"F32","callbacks":474,"deliveredSeconds":4.74,"notifications":[{"kind":"Xrun","message":"A buffer underrun or overrun occurred."}],"audioStored":false,"audioTranscribed":false}
```

设备持续提供有效音频批次；旧版会因一次 Xrun 缓冲波动主动结束录音，错误归因于设备断开。

## 修复

- Xrun、DeviceChanged、RealtimeDenied 不再作为致命错误。启动第一批音频前的 Xrun 不产生丢帧提示；中途丢帧仅提示核对转写，采集继续。
- 权限拒绝、设备不可用、设备格式变化等真正错误保留对应分类和驱动原因，给出针对性的提示。
- 主动结束/取消后到达的关闭通知不会把已录下的音频判为失败。
- 麦克风实时回调通过有界队列交付单声道数据，不等待 UI 状态锁，不在回调里重采样或增长整段录音缓存。
- 独立工作线程将音频转为 16 kHz 单声道 Float32。录音结束先关闭麦克风，再处理队列尾部与重采样尾部，避免丢失已收到的尾音。

## 时长

原来的固定 3 分钟是应用第一版的保守保护，不是模型限制。现在允许在设置中选择 3、10、30 分钟，默认 10 分钟。达到上限只结束并转写，不自动提交答案。

原始音频缓冲约每分钟 3.66 MiB，10 分钟约 36.62 MiB，30 分钟约 109.86 MiB。分配余量、识别模型、特征计算等还会占用内存，这些数字不代表进程总内存。后台仍对输入格式、队列容量和音频样本数设上限。

旧的语音设置文件通过默认字段兼容，原有模型、模型目录和麦克风选择保留。

## 验证

使用应用真实采集代码进行第二次 5 秒检查，之后取消，未写音频文件，也未运行转写：

```json
{"audioTranscribed":false,"audioWritten":false,"deliveredSeconds":4.739625,"error":null,"phase":"recording","stoppedUnexpectedly":false,"warning":null}
```

新增回归测试覆盖非致命通知继续采集、真正断连/权限错误、主动停止后的通知、旧设置兼容、上限校验、缓冲边界、44.1/48 kHz 音频重采样的时长与有效数值，以及前端提示、上限保存和到时只转写一次。

运行诊断需明确进行麦克风检查：`cargo run --example microphone_probe` 或 `cargo run --example application_microphone_probe -- D:/RecallMD/speech-lab.local/models`。两者都只运行 5 秒；前者只计数，后者短暂在内存中缓存后取消，不生成录音文件。
