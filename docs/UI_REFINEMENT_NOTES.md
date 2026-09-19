# UI refinement · 2026-09-19

The first pass refined presentation. The second pass implements the interaction changes approved after the UI review, while preserving persistence and scheduling rules.

- Consistent light/dark palettes, spacing, icons, button hierarchy and focus states.
- Separate workspace identity, file actions, file filter and navigation in the sidebar.
- Label the existing preview toggle; preserve all toolbar actions and shortcuts.
- Improve reading space, review cards, statistics, settings and startup/empty states.
- Keep every entry point available at compact widths; move the document outline below the editor when needed.
- Make outline entries native buttons and label icon controls for keyboard and assistive technology users.

No changes to persistence, autosave timing, FSRS scheduling, database formats, Rust code or dependencies. File operations retain their existing commands and save/conflict guards.

Approved interaction changes:

- Navigation is explicit and idempotent, with a dedicated Notes entry. Opening a file returns to its editor; the existing unsaved-change guard still decides whether a different file may open.
- Save feedback reflects the actual autosave preference. The daily limit has an explicit save action and an unsaved indicator; immediate settings are labeled.
- Settings includes participation management, using `registry_read` and the existing `RESUME` / `INCLUDE` commands. It never calls reset and never changes the scheduler. Read/write failures remain visible, repeated submissions are blocked, and the due badge refreshes after success.
- Skip remains available before and after reveal. Pause and exclusion sit in secondary actions; exclusion requires an explicit confirmation with its recovery path explained.
- Shared native dialogs trap focus, restore it on close and isolate application shortcuts. Escape dismisses cancellable dialogs; conflict and draft decisions still require an explicit choice. Stacked dialogs remain supported.
- File action buttons no longer overlap file names. Low-frequency sidebar tools are visually secondary, and technical explanations are progressively disclosed.

The development-only browser stub now supplies valid scheduler sample data, an event cleanup shim and in-memory participation/configuration state. It remains excluded from production builds. Browser previews use sample data and do not verify native file writes or actual rating submission; those commands intentionally remain unsupported in the stub.

Validation:

- `pnpm typecheck` and `pnpm build` pass.
- `pnpm test`: 19 suites, 189 tests passed, 2 skipped.
- `cargo test --manifest-path src-tauri/Cargo.toml --test m5_review m5_participation_ops_keep_schedule -- --exact`: passed; the existing backend test confirms all four participation transitions preserve scheduling state.
- Browser visual checks: startup, editor, Markdown preview, review before/after reveal, statistics, settings, and new-file dialog; light/dark themes; 1280 × 800, 960 × 600 and 589 × 896 viewports.
- Interaction checks: repeated navigation, file opening from Settings, manual-save feedback, daily-limit save feedback, pause → restore, exclude → re-include, actions after reveal, modal initial focus / Tab cycling / Escape / focus restoration, and dialog isolation from Ctrl+P and review shortcuts.
- Unsaved navigation check: edit a note with autosave disabled, go to Statistics, select a different file, cancel the guard with Escape; Statistics stays open and returning to Notes retains the draft.
- Existing build warning about chunks exceeding 500 kB remains; no bundling changes are included.

Preview with `pnpm dev`, then open `http://127.0.0.1:5173/?demo=editor`. Other demo values: `review`, `stats`, `settings`; omit the query for the startup screen.
