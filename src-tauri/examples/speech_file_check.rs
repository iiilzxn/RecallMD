//! Test selected model IDs on an official example WAV, without opening a microphone.
fn main() {
    let mut args = std::env::args().skip(1);
    let root = std::path::PathBuf::from(args.next().expect("pass prepared model root, followed by model IDs"));
    let wav = sherpa_onnx::Wave::read(root.join("paraformer-bilingual-fp32/test_wavs/0.wav").to_str().unwrap()).unwrap();
    let mut results = Vec::new();
    for slug in args {
        let model = serde_json::from_value(serde_json::json!(slug)).expect("known model ID");
        let started = std::time::Instant::now();
        let text = recallmd_lib::speech::transcribe(&root, model, wav.sample_rate() as u32, wav.samples(), &std::sync::atomic::AtomicBool::new(false)).expect("native transcription");
        assert!(!text.is_empty());
        results.push(serde_json::json!({"model":slug,"text":text,"processingMs":started.elapsed().as_millis()}));
    }
    assert!(!results.is_empty(), "pass at least one model ID");
    println!("{}", serde_json::json!({"sample":"official paraformer 0.wav","microphoneOpened":false,"results":results}));
}
