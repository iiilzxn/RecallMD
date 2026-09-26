//! Short local diagnostic: counts delivered frames and driver notifications only.
//! No waveform is retained, written, transcribed or transmitted.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No default input device")?;
    let supported = device.default_input_config()?;
    let config = supported.config();
    let sample_rate = config.sample_rate;
    let channels = config.channels;
    let samples = Arc::new(AtomicU64::new(0));
    let callbacks = Arc::new(AtomicU64::new(0));
    let notifications = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured_samples = samples.clone(); let delivered_callbacks = callbacks.clone(); let errors = notifications.clone();
    let stream = device.build_input_stream_raw(config, supported.sample_format(), move |data, _| {
        captured_samples.fetch_add(data.len() as u64, Ordering::Relaxed);
        delivered_callbacks.fetch_add(1, Ordering::Relaxed);
    }, move |e| { errors.lock().unwrap().push(serde_json::json!({"kind":format!("{:?}", e.kind()), "message":e.to_string()})); }, None)?;
    stream.play()?;
    std::thread::sleep(std::time::Duration::from_secs(5));
    drop(stream);
    println!("{}", serde_json::json!({"sampleRate":sample_rate,"channels":channels,"sampleFormat":format!("{:?}",supported.sample_format()),"callbacks":callbacks.load(Ordering::Relaxed),"deliveredSeconds":samples.load(Ordering::Relaxed) as f64 / channels as f64 / sample_rate as f64,"notifications":*notifications.lock().unwrap(),"audioStored":false,"audioTranscribed":false}));
    Ok(())
}
