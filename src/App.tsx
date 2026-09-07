import { useState } from "react";
import { M1App } from "./ui/M1App";
import { EditorPanel } from "./m0/EditorPanel";
import { AstPanel } from "./m0/AstPanel";
import { FsrsPanel } from "./m0/FsrsPanel";

function M0Console() {
  return (
    <main className="shell">
      <h1>RecallMD · M0 技术基线验证台</h1>
      <EditorPanel />
      <AstPanel />
      <FsrsPanel />
      <footer className="hint">M0 已验收，结论见 docs/M0_NOTES.md；此页仅作参考保留</footer>
    </main>
  );
}

function App() {
  const [view, setView] = useState<"m1" | "m0">("m1");

  return (
    <>
      <button className="view-switch" onClick={() => setView(view === "m1" ? "m0" : "m1")}>
        {view === "m1" ? "M0 验证台 ↘" : "← 返回编辑器 (M1)"}
      </button>
      {view === "m1" ? <M1App /> : <M0Console />}
    </>
  );
}

export default App;
