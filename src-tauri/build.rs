fn main() {
    tauri_build::build();
    // Cargo test/example executables live below the application directory.
    // Keep their DLLs adjacent too: PATH alone lets Windows load its older
    // system onnxruntime.dll before the matching SDK runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let profile = out.ancestors().nth(3).expect("Cargo profile directory");
        for name in ["onnxruntime.dll", "onnxruntime_providers_shared.dll", "sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll"] {
            let source = std::path::Path::new("resources/speech-runtime").join(name);
            println!("cargo:rerun-if-changed={}", source.display());
            for subdir in ["deps", "examples"] {
                let dest = profile.join(subdir);
                std::fs::create_dir_all(&dest).expect("native runtime directory");
                std::fs::copy(&source, dest.join(name)).expect("stage matching speech DLLs");
            }
        }
    }
}
