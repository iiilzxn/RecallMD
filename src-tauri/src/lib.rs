use serde::Serialize;

#[derive(Serialize)]
pub struct M0Environment {
    rust: String,
    tauri: String,
}

#[tauri::command]
fn m0_environment() -> M0Environment {
    M0Environment {
        rust: format!("rustc {}", env!("CARGO_PKG_RUST_VERSION")),
        tauri: format!("tauri {}", tauri::VERSION),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![m0_environment])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
