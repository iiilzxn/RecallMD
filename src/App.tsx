import { useEffect, useState } from "react";
import { EditorPanel } from "./m0/EditorPanel";
import { AstPanel } from "./m0/AstPanel";
import { FsrsPanel } from "./m0/FsrsPanel";

function App() {
  const [versions, setVersions] = useState<{ rust: string; tauri: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        setVersions(await invoke<{ rust: string; tauri: string }>("m0_environment"));
      } catch (e) {
        setVersions({ rust: `IPC 失败: ${String(e)}`, tauri: "-" });
      }
    })();
  }, []);

  return (
    <main className="shell">
      <header>
        <h1>RecallMD · M0 技术基线验证台</h1>
        <p className="env">
          Rust {versions ? versions.rust : "…"} · Tauri {versions ? versions.tauri : "…"} · WebView
          {navigator.userAgent.includes("Edg/") ? "2" : "?"}
        </p>
      </header>
      <EditorPanel />
      <AstPanel />
      <FsrsPanel />
      <footer className="hint">M0 只验证技术可行性，不含产品功能；结论记录于 docs/M0_NOTES.md</footer>
    </main>
  );
}

export default App;
