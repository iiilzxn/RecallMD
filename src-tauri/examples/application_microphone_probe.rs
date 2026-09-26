//! Exercise the application's actual capture path; cancel without transcription.
//! Five seconds of PCM are held only in RAM and discarded, with no audio logging.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("pass prepared model root"));
    let directory = std::path::PathBuf::from(std::env::var_os("APPDATA").ok_or("No application config directory")?).join("com.recallmd.desktop");
    let config = recallmd_lib::speech::read_config(&directory, &root)?;
    let service = recallmd_lib::speech::SpeechService::default();
    let session = uuid::Uuid::new_v4().to_string();
    service.start(session.clone(), config)?;
    std::thread::sleep(std::time::Duration::from_secs(5));
    let status = service.status(&session);
    service.cancel(&session);
    let status = status?;
    println!("{}", serde_json::json!({"phase":status.phase,"deliveredSeconds":status.seconds,"stoppedUnexpectedly":status.stopped,"error":status.error,"warning":status.warning,"audioWritten":false,"audioTranscribed":false}));
    assert!(status.error.is_none() && !status.stopped && status.seconds > 3.5, "microphone must keep delivering audio after startup notifications");
    Ok(())
}
