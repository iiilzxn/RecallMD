//! Read-only native setup check; enumerates devices but never opens the microphone.
fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("pass prepared model root"));
    let status = recallmd_lib::speech::config_status(&root.join(".read-only-check"), &root).expect("model status");
    assert_eq!(status.models.len(), 1, "only Paraformer FP32 is offered");
    assert!(status.models.iter().all(|model| model.ready), "Paraformer FP32 must be ready");
    let devices = recallmd_lib::speech::devices().expect("input device enumeration");
    println!("{}", serde_json::json!({ "modelsReady": status.models.len(), "inputDevices": devices.len(), "microphoneOpened": false }));
}
