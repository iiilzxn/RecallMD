//! Local CPU dictation. Microphone capture starts only on an explicit command.
//! Audio lives in a bounded RAM buffer; it is never written to disk or uploaded.
use crate::persistence::{error::{HostError, HostResult}, util::write_file_atomic};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering}}, time::{Duration, Instant}};

pub const MAX_SECONDS: u32 = 30 * 60;
const RECORDING_SAMPLE_RATE: u32 = 16_000;
const RECORDING_LIMITS: [u32; 3] = [3 * 60, 10 * 60, MAX_SECONDS];
fn default_max_seconds() -> u32 { 10 * 60 }
const CONFIG_FILE: &str = "speech-settings.json";
fn error(code: &str, message: impl Into<String>) -> HostError { HostError::new(code, message) }
fn cancelled() -> HostError { error("SPEECH_CANCELLED", "录音已取消") }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelId {
    // Migrate saved selections from the old comparison build to the retained model.
    #[serde(rename = "paraformer-bilingual-fp32", alias = "paraformer-bilingual",
        alias = "zipformer-small-zh", alias = "zipformer-small-zh-fp32",
        alias = "zipformer-small-bilingual", alias = "zipformer-small-bilingual-fp32",
        alias = "sensevoice-small", alias = "sensevoice-small-fp32")]
    ParaformerBilingualFp32,
}
impl Default for ModelId { fn default() -> Self { Self::ParaformerBilingualFp32 } }
const ALL_MODELS: [ModelId; 1] = [ModelId::ParaformerBilingualFp32];
impl ModelId {
    pub fn slug(self) -> &'static str { "paraformer-bilingual-fp32" }
    fn package(self) -> &'static str { "sherpa-onnx-streaming-paraformer-bilingual-zh-en" }
    fn files(self) -> &'static [(&'static str, u64)] {
        &[("encoder.onnx",636348877),("decoder.onnx",228464044),("tokens.txt",75756)]
    }
    fn label(self) -> &'static str { "Paraformer 中英双语 · FP32 原版" }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConfig {
    pub enabled: bool, pub model: ModelId, pub models_root: PathBuf, pub device: Option<String>,
    #[serde(default = "default_max_seconds")]
    pub max_seconds: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus { pub id: ModelId, pub label: &'static str, pub ready: bool, pub missing: Vec<String>, pub size_mib: u32 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus { #[serde(flatten)] pub config: SavedConfig, pub models: Vec<ModelStatus> }

pub fn read_config(dir: &Path, default_root: &Path) -> HostResult<SavedConfig> {
    match std::fs::read(dir.join(CONFIG_FILE)) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|_| error("SPEECH_CONFIG", "语音设置无法读取，请在设置中重新选择模型目录")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SavedConfig { enabled: true, model: ModelId::default(), models_root: default_root.to_owned(), device: None, max_seconds: default_max_seconds() }),
        Err(_) => Err(error("SPEECH_CONFIG", "无法读取本机语音设置")),
    }
}
fn model_dir(root: &Path, id: ModelId) -> PathBuf {
    [root.join(id.slug()), root.join(id.package()), root.join("paraformer-bilingual"), root.to_owned()].into_iter()
        .find(|path| path.join(id.files()[0].0).is_file()).unwrap_or_else(|| root.join(id.slug()))
}
fn missing_files(path: &Path, id: ModelId) -> Vec<String> {
    id.files().iter().filter(|(name, size)| std::fs::metadata(path.join(name)).map(|m| !m.is_file() || m.len() != *size).unwrap_or(true))
        .map(|(name, _)| name.to_string()).collect()
}
pub fn config_status(dir: &Path, default_root: &Path) -> HostResult<ConfigStatus> {
    let config = read_config(dir, default_root)?;
    let models = ALL_MODELS.iter().map(|&id| {
        let missing = missing_files(&model_dir(&config.models_root, id), id);
        ModelStatus { id, label: id.label(), ready: missing.is_empty(), missing, size_mib: ((id.files().iter().map(|(_, size)| size).sum::<u64>() + 524_288) / 1_048_576) as u32 }
    }).collect();
    Ok(ConfigStatus { config, models })
}
pub fn save_config(dir: &Path, default_root: &Path, config: SavedConfig) -> HostResult<ConfigStatus> {
    if !config.models_root.is_absolute() { return Err(error("SPEECH_CONFIG", "请选择模型文件夹的完整路径")); }
    validate_limit(config.max_seconds)?;
    std::fs::create_dir_all(dir).map_err(|_| error("SPEECH_CONFIG", "无法保存语音设置"))?;
    write_file_atomic(&dir.join(CONFIG_FILE), &serde_json::to_vec(&config).expect("speech config"))?;
    config_status(dir, default_root)
}
fn validate_limit(seconds: u32) -> HostResult<()> {
    if !RECORDING_LIMITS.contains(&seconds) { return Err(error("SPEECH_CONFIG", "录音上限请选择 3、10 或 30 分钟")); }
    Ok(())
}
pub fn devices() -> HostResult<Vec<String>> {
    let host = cpal::default_host();
    let devices = host.input_devices().map_err(|_| error("SPEECH_DEVICE", "无法读取麦克风列表，请检查系统的麦克风权限"))?;
    Ok(devices.filter_map(|d| d.description().ok().map(|v| v.name().to_string())).collect())
}

#[derive(Default)]
struct Audio { samples: Vec<f32>, sample_rate: u32, device: String, error: Option<HostError> }
struct Capture {
    id: String, model: ModelId, root: PathBuf, max_seconds: u32, audio: Mutex<Audio>,
    stop: AtomicBool, cancelled: AtomicBool, done: AtomicBool, phase: AtomicU8, level: AtomicU32,
    received_audio: AtomicBool, gaps: AtomicU32,
}
impl Capture {
    fn new(id: String, config: &SavedConfig) -> Self { Self { id, model: config.model, root: config.models_root.clone(), max_seconds: config.max_seconds, audio: Mutex::default(), stop: AtomicBool::new(false), cancelled: AtomicBool::new(false), done: AtomicBool::new(false), phase: AtomicU8::new(0), level: AtomicU32::new(0), received_audio: AtomicBool::new(false), gaps: AtomicU32::new(0) } }
}
#[derive(Default)]
struct Sessions { active: Option<Arc<Capture>>, cancelled: VecDeque<String> }
#[derive(Default)]
pub struct SpeechService { sessions: Mutex<Sessions>, inference: Mutex<()> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus { pub session_id: String, pub phase: &'static str, pub seconds: f64, pub level: f32, pub stopped: bool, pub device: String, pub error: Option<String>, pub warning: Option<String> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript { pub session_id: String, pub model: ModelId, pub text: String, pub audio_seconds: f64, pub processing_ms: u64 }

impl SpeechService {
    fn finish(&self, id: &str) { let mut sessions = self.sessions.lock().unwrap(); if sessions.active.as_ref().is_some_and(|s| s.id == id) { sessions.active = None; } }
    fn session(&self, id: &str) -> HostResult<Arc<Capture>> { self.sessions.lock().unwrap().active.as_ref().filter(|s| s.id == id).cloned().ok_or_else(cancelled) }
    pub fn cancel(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        // Tombstones also cover a cancellation arriving before start finishes validation.
        if !sessions.cancelled.iter().any(|s| s == id) { sessions.cancelled.push_back(id.to_string()); }
        while sessions.cancelled.len() > 128 { sessions.cancelled.pop_front(); }
        if sessions.active.as_ref().is_some_and(|s| s.id == id) {
            let capture = sessions.active.take().unwrap();
            capture.cancelled.store(true, Ordering::Release); capture.stop.store(true, Ordering::Release);
        }
    }
    pub fn cancel_all(&self) { let id = self.sessions.lock().unwrap().active.as_ref().map(|c| c.id.clone()); if let Some(id) = id { self.cancel(&id); } }
    pub fn start(&self, id: String, config: SavedConfig) -> HostResult<CaptureStatus> {
        if uuid::Uuid::parse_str(&id).is_err() { return Err(error("SPEECH_SESSION", "录音标识无效，请重试")); }
        if !config.enabled { return Err(error("SPEECH_DISABLED", "请先在设置中开启语音输入")); }
        validate_limit(config.max_seconds)?;
        if !missing_files(&model_dir(&config.models_root, config.model), config.model).is_empty() { return Err(error("SPEECH_MODEL_MISSING", "所选模型文件缺失或版本不匹配，请在设置中选择正确的模型目录")); }
        let capture = Arc::new(Capture::new(id.clone(), &config));
        {
            let mut sessions = self.sessions.lock().unwrap();
            if sessions.cancelled.contains(&id) { return Err(cancelled()); }
            if sessions.active.is_some() { return Err(error("SPEECH_BUSY", "已有录音或转写正在进行，请先结束或取消")); }
            sessions.active = Some(capture.clone());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let worker = capture.clone();
        std::thread::spawn(move || {
            if let Err(e) = record(&worker, config.device.as_deref(), &tx) {
                worker.audio.lock().unwrap().error = Some(e.clone());
                let _ = tx.try_send(Err(e));
            }
            worker.done.store(true, Ordering::Release);
        });
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) if !capture.cancelled.load(Ordering::Acquire) => self.status(&id),
            Ok(Err(e)) => { self.cancel(&id); Err(e) },
            _ => { self.cancel(&id); Err(error("SPEECH_DEVICE", "无法启动麦克风，请检查设备和系统麦克风权限后重试")) },
        }
    }
    pub fn status(&self, id: &str) -> HostResult<CaptureStatus> {
        let capture = self.session(id)?;
        let audio = capture.audio.lock().unwrap();
        Ok(CaptureStatus { session_id: id.to_string(), phase: match capture.phase.load(Ordering::Acquire) { 0 => "starting", 1 => "recording", _ => "transcribing" },
            seconds: if audio.sample_rate > 0 { audio.samples.len() as f64 / audio.sample_rate as f64 } else { 0.0 },
            level: f32::from_bits(capture.level.load(Ordering::Relaxed)), stopped: capture.done.load(Ordering::Acquire), device: audio.device.clone(), error: audio.error.as_ref().map(|e| e.message.clone()),
            warning: if capture.gaps.load(Ordering::Relaxed) > 0 { Some("录音中出现过短暂丢帧，仍在继续；转写后请核对文字。".into()) } else { None } })
    }
    pub fn stop(&self, id: &str) -> HostResult<Transcript> {
        let capture = self.session(id)?;
        if capture.phase.compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err(error("SPEECH_BUSY", "麦克风正在启动或已有转写请求，请稍候")); }
        capture.stop.store(true, Ordering::Release);
        let result = (|| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !capture.done.load(Ordering::Acquire) {
                if Instant::now() > deadline { return Err(error("SPEECH_DEVICE", "麦克风未能及时关闭，请重新连接设备")); }
                if capture.cancelled.load(Ordering::Acquire) { return Err(cancelled()); }
                std::thread::sleep(Duration::from_millis(10));
            }
            let (samples, sample_rate) = { let mut audio = capture.audio.lock().unwrap();
                if let Some(error) = &audio.error { return Err(error.clone()); }
                (std::mem::take(&mut audio.samples), audio.sample_rate)
            };
            if sample_rate == 0 || samples.len() < sample_rate as usize / 4 || !samples.iter().any(|s| s.abs() > 0.00001) { return Err(error("SPEECH_NO_AUDIO", "没有录到有效声音，请检查麦克风后再试一次")); }
            let _serial = self.inference.lock().unwrap();
            let started = Instant::now();
            let text = transcribe(&capture.root, capture.model, sample_rate, &samples, &capture.cancelled)?;
            if text.trim().is_empty() { return Err(error("SPEECH_EMPTY", "没有识别出文字，请靠近麦克风重新录制")); }
            Ok(Transcript { session_id: id.to_owned(), model: capture.model, text, audio_seconds: samples.len() as f64 / sample_rate as f64, processing_ms: started.elapsed().as_millis() as u64 })
        })();
        self.finish(id);
        result
    }
}

fn device_error(stage: &str, e: &cpal::Error) -> HostError {
    let (code, advice) = match e.kind() {
        cpal::ErrorKind::PermissionDenied => ("SPEECH_PERMISSION", "系统拒绝访问麦克风，请在 Windows 隐私设置中允许桌面应用访问麦克风"),
        cpal::ErrorKind::DeviceBusy => ("SPEECH_DEVICE_BUSY", "麦克风正被占用，请关闭占用设备的程序后重试"),
        cpal::ErrorKind::DeviceNotAvailable => ("SPEECH_DEVICE_UNAVAILABLE", "麦克风已断开或不可用，请重新连接或在语音设置中选择其他设备"),
        cpal::ErrorKind::StreamInvalidated => ("SPEECH_STREAM_INVALIDATED", "系统音频设备或格式发生变化，请重新开始录音"),
        cpal::ErrorKind::UnsupportedConfig | cpal::ErrorKind::UnsupportedOperation => ("SPEECH_FORMAT", "麦克风不支持当前录音格式，请在语音设置中选择其他输入设备"),
        cpal::ErrorKind::HostUnavailable => ("SPEECH_AUDIO_SERVICE", "系统音频服务不可用，请检查 Windows 音频服务"),
        _ => ("SPEECH_DEVICE", "录音发生错误，请重试或更换输入设备"),
    };
    let detail: String = e.to_string().chars().take(300).collect();
    error(code, format!("{advice}（{stage} / {:?}：{detail}）", e.kind()))
}

fn handle_input_error(capture: &Capture, e: cpal::Error) {
    // Shutdown notifications after an explicit stop must not invalidate captured audio.
    if capture.stop.load(Ordering::Acquire) { return; }
    match e.kind() {
        // CPAL's error callback also carries non-fatal notifications. WASAPI
        // commonly signals discontinuity on the first packet, then keeps delivering audio.
        cpal::ErrorKind::Xrun => {
            if capture.received_audio.load(Ordering::Relaxed) { capture.gaps.fetch_add(1, Ordering::Relaxed); }
        },
        cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied => {},
        _ => {
            capture.audio.lock().unwrap().error = Some(device_error("录音", &e));
            capture.stop.store(true, Ordering::Release);
        },
    }
}

fn append_recording(capture: &Capture, normalized: &[f32]) {
    if capture.cancelled.load(Ordering::Acquire) { return; }
    let limit = RECORDING_SAMPLE_RATE as usize * capture.max_seconds as usize;
    let mut audio = capture.audio.lock().unwrap();
    let count = normalized.len().min(limit.saturating_sub(audio.samples.len()));
    audio.samples.extend_from_slice(&normalized[..count]);
    if audio.samples.len() >= limit { capture.stop.store(true, Ordering::Release); }
}

fn record(capture: &Arc<Capture>, requested: Option<&str>, ready: &std::sync::mpsc::SyncSender<HostResult<()>>) -> HostResult<()> {
    if capture.cancelled.load(Ordering::Acquire) { return Err(cancelled()); }
    let host = cpal::default_host();
    let device = if let Some(name) = requested {
        host.input_devices().ok().and_then(|mut devices| devices.find(|d| d.description().map(|v| v.name() == name).unwrap_or(false)))
    } else { host.default_input_device() }.ok_or_else(|| error("SPEECH_DEVICE", "未找到可用的麦克风，请在设置中选择设备或检查系统输入设备"))?;
    let supported = device.default_input_config().map_err(|e| device_error("打开设备", &e))?;
    let config = supported.config();
    if !(8000..=192000).contains(&config.sample_rate) || config.channels == 0 || config.channels > 32 { return Err(error("SPEECH_DEVICE", "麦克风音频格式不受支持，请更换设备")); }
    let resampler = if config.sample_rate != RECORDING_SAMPLE_RATE {
        Some(sherpa_onnx::LinearResampler::create(config.sample_rate as i32, RECORDING_SAMPLE_RATE as i32).ok_or_else(|| error("SPEECH_RESAMPLE", "无法转换麦克风采样率，请更换输入设备"))?)
    } else { None };
    { let mut audio = capture.audio.lock().unwrap(); audio.sample_rate = RECORDING_SAMPLE_RATE; audio.device = device.description().map(|v| v.name().to_owned()).unwrap_or_default(); }
    // Keep resampling, buffer growth and status locks off the real-time audio thread.
    let (chunks_tx, chunks_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(32);
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => input_stream::<f32>(&device, config, capture.clone(), chunks_tx),
        cpal::SampleFormat::I16 => input_stream::<i16>(&device, config, capture.clone(), chunks_tx),
        cpal::SampleFormat::U16 => input_stream::<u16>(&device, config, capture.clone(), chunks_tx),
        cpal::SampleFormat::I32 => input_stream::<i32>(&device, config, capture.clone(), chunks_tx),
        cpal::SampleFormat::F64 => input_stream::<f64>(&device, config, capture.clone(), chunks_tx),
        _ => return Err(error("SPEECH_DEVICE", "麦克风采样格式暂不支持，请更换输入设备")),
    }?;
    if capture.cancelled.load(Ordering::Acquire) { return Err(cancelled()); }
    stream.play().map_err(|e| device_error("开始录音", &e))?;
    capture.phase.store(1, Ordering::Release);
    let _ = ready.send(Ok(()));
    let started = Instant::now();
    let process_chunk = |chunk: &[f32]| {
        if let Some(resampler) = &resampler { append_recording(capture, &resampler.resample(chunk, false)); }
        else { append_recording(capture, chunk); }
    };
    while !capture.stop.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(capture.max_seconds as u64) {
        match chunks_rx.recv_timeout(Duration::from_millis(30)) {
            Ok(chunk) => process_chunk(&chunk),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {},
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    capture.stop.store(true, Ordering::Release);
    drop(stream); // Release the microphone before any model inference.
    if !capture.cancelled.load(Ordering::Acquire) {
        // Include frames already delivered before the user clicked stop.
        for chunk in chunks_rx.try_iter() { process_chunk(&chunk); }
        if let Some(resampler) = &resampler { append_recording(capture, &resampler.resample(&[], true)); }
    }
    Ok(())
}
fn input_stream<T>(device: &cpal::Device, config: cpal::StreamConfig, capture: Arc<Capture>, chunks: std::sync::mpsc::SyncSender<Vec<f32>>) -> HostResult<cpal::Stream>
where T: cpal::SizedSample, f32: cpal::FromSample<T> {
    let channels = config.channels as usize;
    let failed = capture.clone();
    device.build_input_stream(config, move |data: &[T], _| {
        if capture.stop.load(Ordering::Acquire) { return; }
        let mut mono = Vec::with_capacity(data.len() / channels);
        let mut peak = 0.0f32;
        for frame in data.chunks_exact(channels) {
            let sample = frame.iter().map(|v| <f32 as cpal::FromSample<T>>::from_sample_(*v)).sum::<f32>() / channels as f32;
            let sample = if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 };
            peak = peak.max(sample.abs()); mono.push(sample);
        }
        if mono.is_empty() { return; }
        capture.received_audio.store(true, Ordering::Relaxed);
        capture.level.store(peak.to_bits(), Ordering::Relaxed);
        if matches!(chunks.try_send(mono), Err(std::sync::mpsc::TrySendError::Full(_))) { capture.gaps.fetch_add(1, Ordering::Relaxed); }
    }, move |e| handle_input_error(&failed, e), None).map_err(|e| device_error("建立录音流", &e))
}

/// Also used by the native smoke test, so file and microphone audio share one path.
pub fn transcribe(root: &Path, id: ModelId, sample_rate: u32, samples: &[f32], cancel: &AtomicBool) -> HostResult<String> {
    if cancel.load(Ordering::Acquire) { return Err(cancelled()); }
    if !(8000..=192000).contains(&sample_rate) || samples.len() > sample_rate as usize * MAX_SECONDS as usize { return Err(error("SPEECH_AUDIO", "音频长度或采样率无效")); }
    let dir = model_dir(root, id);
    if !missing_files(&dir, id).is_empty() { return Err(error("SPEECH_MODEL_MISSING", "模型文件缺失或版本不匹配，请重新选择模型目录")); }
    let file = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let load_error = || error("SPEECH_MODEL_LOAD", "模型加载失败，请确认模型文件完整并重试");
    // Readiness and inference both use the same unquantized Paraformer files.
    let mut config = sherpa_onnx::OnlineRecognizerConfig::default();
    config.model_config.num_threads = 2; config.model_config.provider = Some("cpu".into()); config.model_config.tokens = file("tokens.txt");
    config.decoding_method = Some("greedy_search".into()); config.enable_endpoint = false;
    config.model_config.paraformer.encoder = file(id.files()[0].0);
    config.model_config.paraformer.decoder = file(id.files()[1].0);
    let engine = sherpa_onnx::OnlineRecognizer::create(&config).ok_or_else(load_error)?;
    let stream = engine.create_stream();
    if cancel.load(Ordering::Acquire) { return Err(cancelled()); }
    stream.accept_waveform(sample_rate as i32, samples);
    // Flush the Paraformer encoder's right context after the recording.
    stream.accept_waveform(sample_rate as i32, &vec![0.0; sample_rate as usize]); stream.input_finished();
    while engine.is_ready(&stream) { if cancel.load(Ordering::Acquire) { return Err(cancelled()); } engine.decode(&stream); }
    let text = engine.get_result(&stream).map(|r| r.text).unwrap_or_default();
    if cancel.load(Ordering::Acquire) { return Err(cancelled()); }
    Ok(text.trim().replace("<unk>", "（未识别）"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_capture(seconds: u32) -> Capture {
        Capture::new("test".into(), &SavedConfig { enabled: true, model: ModelId::default(), models_root: PathBuf::from("C:/models"), device: None, max_seconds: seconds })
    }
    #[test] fn recoverable_notifications_do_not_stop_recording() {
        let capture = test_capture(600);
        // The actual device emits Xrun before its first valid input packet.
        handle_input_error(&capture, cpal::ErrorKind::Xrun.into());
        assert_eq!(capture.gaps.load(Ordering::Relaxed), 0);
        capture.received_audio.store(true, Ordering::Relaxed);
        for kind in [cpal::ErrorKind::Xrun, cpal::ErrorKind::DeviceChanged, cpal::ErrorKind::RealtimeDenied] {
            handle_input_error(&capture, kind.into());
            assert!(!capture.stop.load(Ordering::Acquire));
            assert!(capture.audio.lock().unwrap().error.is_none());
        }
        append_recording(&capture, &[0.1, 0.2, 0.3]);
        assert_eq!(capture.audio.lock().unwrap().samples.len(), 3);
        assert_eq!(capture.gaps.load(Ordering::Relaxed), 1);
    }
    #[test] fn fatal_device_errors_keep_the_real_error_kind() {
        for (kind, code) in [(cpal::ErrorKind::PermissionDenied, "SPEECH_PERMISSION"), (cpal::ErrorKind::DeviceNotAvailable, "SPEECH_DEVICE_UNAVAILABLE"), (cpal::ErrorKind::StreamInvalidated, "SPEECH_STREAM_INVALIDATED")] {
            let capture = test_capture(600);
            handle_input_error(&capture, cpal::Error::with_message(kind, "driver detail"));
            assert!(capture.stop.load(Ordering::Acquire));
            let guard = capture.audio.lock().unwrap();
            let error = guard.error.as_ref().unwrap();
            assert_eq!(error.code, code);
            assert!(error.message.contains("driver detail"));
            assert!(error.message.contains(&format!("{kind:?}")));
        }
    }
    #[test] fn shutdown_notifications_do_not_turn_a_successful_stop_into_an_error() {
        let capture = test_capture(600);
        append_recording(&capture, &[0.1, 0.2]);
        capture.stop.store(true, Ordering::Release);
        handle_input_error(&capture, cpal::ErrorKind::StreamInvalidated.into());
        let audio = capture.audio.lock().unwrap();
        assert_eq!(audio.samples.len(), 2);
        assert!(audio.error.is_none());
    }
    #[test] fn old_preferences_migrate_to_paraformer_and_keep_recording_preferences() {
        let old = r#"{"enabled":true,"model":"paraformer-bilingual","modelsRoot":"C:/models","device":null}"#;
        let config: SavedConfig = serde_json::from_str(old).unwrap();
        assert_eq!(config.model, ModelId::ParaformerBilingualFp32);
        assert_eq!(config.max_seconds, 600);
        for value in [0, 1, 181, 1801, u32::MAX] { assert!(validate_limit(value).is_err()); }
        for value in RECORDING_LIMITS { assert!(validate_limit(value).is_ok()); }
        let mut config = config; config.max_seconds = 1800;
        let roundtrip: SavedConfig = serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(roundtrip.max_seconds, 1800);
    }
    #[test] fn normalized_buffer_is_bounded_and_never_appends_cancelled_audio() {
        let capture = test_capture(180);
        let cap = RECORDING_SAMPLE_RATE as usize * 180;
        capture.audio.lock().unwrap().samples.resize(cap - 2, 0.0);
        append_recording(&capture, &[0.1; 10]);
        assert_eq!(capture.audio.lock().unwrap().samples.len(), cap);
        assert!(capture.stop.load(Ordering::Acquire));
        let cancelled = test_capture(600);
        cancelled.cancelled.store(true, Ordering::Release);
        append_recording(&cancelled, &[0.1; 10]);
        assert!(cancelled.audio.lock().unwrap().samples.is_empty());
    }
    #[test] fn resampling_preserves_duration_across_microphone_packet_boundaries() {
        for rate in [44100, 48000] {
            let resampler = sherpa_onnx::LinearResampler::create(rate, RECORDING_SAMPLE_RATE as i32).unwrap();
            let audio: Vec<f32> = (0..rate).map(|i| (i as f32 * std::f32::consts::TAU * 440.0 / rate as f32).sin() * 0.2).collect();
            let mut normalized = Vec::new();
            for chunk in audio.chunks(317) { normalized.extend(resampler.resample(chunk, false)); }
            normalized.extend(resampler.resample(&[], true));
            assert!(normalized.len().abs_diff(RECORDING_SAMPLE_RATE as usize) <= 1);
            assert!(normalized.iter().all(|s| s.is_finite()));
            assert!(normalized.iter().any(|s| s.abs() > 0.1));
        }
    }
    #[test] fn unknown_model_is_rejected() { assert!(serde_json::from_str::<ModelId>("\"../../other\"").is_err()); }
    #[test] fn removed_model_preferences_migrate_without_resetting_device_or_limit() {
        for old in ["zipformer-small-zh", "zipformer-small-zh-fp32", "zipformer-small-bilingual", "zipformer-small-bilingual-fp32", "paraformer-bilingual", "sensevoice-small", "sensevoice-small-fp32"] {
            let config: SavedConfig = serde_json::from_value(serde_json::json!({
                "enabled": false, "model": old, "modelsRoot": "C:/models", "device": "saved microphone", "maxSeconds": 1800
            })).unwrap();
            assert_eq!(config.model, ModelId::ParaformerBilingualFp32);
            assert!(!config.enabled);
            assert_eq!(config.device.as_deref(), Some("saved microphone"));
            assert_eq!(config.max_seconds, 1800);
            assert_eq!(config.models_root, PathBuf::from("C:/models"));
            assert_eq!(serde_json::to_value(config).unwrap()["model"], "paraformer-bilingual-fp32");
        }
    }
    #[test] fn fp32_selection_survives_save_and_missing_weights_never_fall_back_to_int8() {
        let root = std::env::temp_dir().join(format!("recallmd-speech-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result = || {
            // A folder containing only INT8 weights must not satisfy an FP32 selection.
            for name in ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"] {
                std::fs::write(root.join(name), []).unwrap();
            }
            let config = SavedConfig { enabled: true, model: ModelId::ParaformerBilingualFp32, models_root: root.clone(), device: Some("chosen mic".into()), max_seconds: 180 };
            let status = save_config(&root, &root, config).unwrap();
            assert_eq!(status.models.len(), 1);
            assert_eq!(status.config.model, ModelId::ParaformerBilingualFp32);
            assert_eq!(status.config.device.as_deref(), Some("chosen mic"));
            assert_eq!(status.config.max_seconds, 180);
            let original = status.models.iter().find(|m| m.id == status.config.model).unwrap();
            assert!(!original.ready);
            assert!(original.missing.contains(&"encoder.onnx".to_string()));
            assert!(original.missing.contains(&"decoder.onnx".to_string()));
            assert_eq!(transcribe(&root, status.config.model, 16000, &[0.1; 160], &AtomicBool::new(false)).unwrap_err().code, "SPEECH_MODEL_MISSING");
        };
        let outcome = std::panic::catch_unwind(result);
        std::fs::remove_dir_all(&root).unwrap();
        outcome.unwrap();
    }
    #[test] fn cancelled_start_never_records() {
        let service = SpeechService::default(); let id = uuid::Uuid::new_v4().to_string(); service.cancel(&id);
        assert!(service.sessions.lock().unwrap().cancelled.contains(&id));
        assert!(service.sessions.lock().unwrap().active.is_none());
    }
    #[test] fn cancelling_old_session_does_not_stop_new_one() {
        let service = SpeechService::default();
        let config = SavedConfig { enabled: true, model: ModelId::default(), models_root: PathBuf::from("C:/models"), device: None, max_seconds: default_max_seconds() };
        let current = Arc::new(Capture::new("new".into(), &config));
        service.sessions.lock().unwrap().active = Some(current.clone());
        service.cancel("old"); assert!(!current.stop.load(Ordering::Acquire));
        service.finish("old"); assert!(service.session("new").is_ok());
        service.cancel("new"); assert!(current.stop.load(Ordering::Acquire)); assert!(current.cancelled.load(Ordering::Acquire));
    }
    #[test] fn invalid_audio_and_cancelled_decode_do_not_load_models() {
        assert_eq!(transcribe(Path::new("missing"), ModelId::default(), 0, &[], &AtomicBool::new(false)).unwrap_err().code, "SPEECH_AUDIO");
        assert_eq!(transcribe(Path::new("missing"), ModelId::default(), 16000, &[], &AtomicBool::new(true)).unwrap_err().code, "SPEECH_CANCELLED");
    }
    #[test] #[ignore = "Requires the local Paraformer FP32 model; never captures microphone audio"]
    fn local_models_native_smoke() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../speech-lab.local/models");
        let wav = sherpa_onnx::Wave::read(root.join("paraformer-bilingual-fp32/test_wavs/0.wav").to_str().unwrap()).unwrap();
        for id in ALL_MODELS { let text = transcribe(&root, id, wav.sample_rate() as u32, wav.samples(), &AtomicBool::new(false)).unwrap(); assert!(!text.is_empty()); println!("{}: {text}", id.slug()); }
    }
}
