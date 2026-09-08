import { useState } from "react";
import { M2App } from "./ui/M2App";
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
  const [view, setView] = useState<"m2" | "m0">("m2");

  return (
    <>
      <button className="view-switch" onClick={() => setView(view === "m2" ? "m0" : "m2")}>
        {view === "m2" ? "M0 验证台 ↘" : "← 返回应用 (M2)"}
      </button>
      {view === "m2" ? <M2App /> : <M0Console />}
    </>
  );
}

export default App;
