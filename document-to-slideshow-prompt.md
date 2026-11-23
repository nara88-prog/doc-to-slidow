# Prompt: "Converting Document into a Slide Show"

Three-layer prompt format — Role & Context → Task & Requirements → Constraints & Output.
Read top-to-bottom as one continuous prompt.

---

## LAYER 1 — ROLE & CONTEXT

*Who is the engineer, and in what context?*

You are a **senior software engineer** with 8+ years of experience shipping offline-first desktop applications (Electron / Tauri + React or Svelte), document-parsing pipelines, and presentation tooling. You are the tech lead on a small team, so you own architecture, UI/UX quality, and code review standards.

**Context:** The client is a professional who regularly receives piles of documents (PDF, DOCX, PPTX, TXT, MD, HTML) and must turn them into a presentation. Their environment is unreliable or air-gapped — **no internet can be assumed at runtime**. They are not technical, so the app must feel like a consumer product, not a developer tool. Nothing about their documents may leave their machine.

> **EXAMPLE:** "Act as a senior software engineer building an offline-first desktop app for non-technical users. The product is **'Converting Document into a Slide Show'**: upload documents, get one catchy slide deck. Constraint: everything — parsing, summarizing, slide generation, export — must run 100% locally with zero network calls."

---

## LAYER 2 — TASK & REQUIREMENTS

*What exactly must be built?*

Build the app **"Converting Document into a Slide Show"** with these concrete features:

1. **Three input methods, one screen**
   - **Browse / open directory** — file picker supporting multi-select and whole-folder import.
   - **Drag & drop** into a dedicated, clearly labeled drop column (with hover/active state and file-count feedback).
   - **Paste a link** — a URL field that accepts **multiple links at once** (one per line).
2. **Batch ingestion logic**
   - Multiple files per upload, and files from different sources can be mixed in one queue.
   - **One link may contain multiple documents** (e.g., a folder/listing page) — the app must detect, list, and enqueue every document found inside it, showing the user what was discovered before processing.
   - Multiple links pasted at once are all resolved and merged into the same queue.
   - Per-item queue UI: filename, source, size, status (queued → parsing → summarizing → done / error), progress bar, cancel and retry.
3. **Processing pipeline (offline)**
   - Extract text per format (PDF, DOCX, PPTX, TXT, MD, HTML), strip boilerplate, chunk, and detect headings/structure.
   - **Summarize each document**, then **merge all summaries into one unified narrative outline** — deduplicate overlapping points, order logically (intro → body → conclusion).
   - Generate slides: punchy slide titles, 3–5 concise bullets each, speaker notes, and a suggested visual/icon per slide. Tone: catchy and presentation-ready, not a wall of text.
4. **Summarization engine**
   - Default: local extractive summarizer (TF-IDF / TextRank, pure JS).
   - Optional upgrade: local LLM via Ollama or llama.cpp if present, auto-detected and silently skipped if not.
   - Never block or fail because the LLM is missing — always fall back to the built-in summarizer.
5. **Slide workspace**
   - Live preview of the generated deck, editable text, drag-to-reorder slides, theme picker (3–5 built-in themes).
   - Present mode (fullscreen, arrow-key navigation).
   - **Export** to PPTX, PDF, and standalone HTML.
6. **User-friendliness**
   - Single-window, three-step flow: *Add documents → Review summary → Present & export*.
   - Empty states, inline validation, human-readable error messages ("This PDF is password-protected"), toast confirmations, dark/light theme, full keyboard navigation.

> **EXAMPLE:** "Build the app with: (1) a drag-and-drop column + file picker + multi-URL paste field, (2) a queue that expands a single link into all documents it contains, (3) a local extract → chunk → summarize → merge → slide-generation pipeline, (4) an editable slide workspace with themes, present mode, and PPTX/PDF/HTML export."

---

## LAYER 3 — CONSTRAINTS & OUTPUT

*How must the result look and behave?*

**Hard constraints**
- **Works fully offline.** No CDN links, no external fonts, no analytics, no telemetry, no runtime network requests except the explicit user-supplied URL fetch.
- All libraries must be **vendored/bundled locally**; the built app must launch and function with Wi-Fi disabled.
- **Framework freedom:** for local/non-URL input you may use any framework that suits the job (Electron or Tauri + React/Svelte, or plain HTML/CSS/JS if simpler) — chosen for offline capability, bundle size, and speed, not trends.
- URL input is the *only* network-dependent path: if offline, show a clear "queued for when you're online" state instead of an error; handle CORS/proxy limits gracefully.
- Never upload, cache to cloud, or log document contents.

**Quality bar**
- Clean architecture: separated `parsers/`, `summarizer/`, `slides/`, `ui/`, with typed interfaces between stages.
- Accessibility: WCAG AA contrast, focus rings, ARIA labels, screen-reader-friendly queue.
- Performance: 50-page PDF summarized in under ~10s on a mid-range laptop; UI never freezes (work off the main thread).

**Deliverables**
1. Folder structure + tech-stack decision with a one-paragraph justification.
2. Full working source code, commented at each pipeline stage.
3. `README` with install, build, and run instructions.
4. **Offline verification checklist** — e.g., "open DevTools → Network → confirm 0 requests during a full document-to-deck run".
5. Acceptance criteria as a checklist I can tick off.

> **EXAMPLE:** "Output: repo tree, tech-stack rationale, complete commented source, README, and an offline-proof checklist ('build once, disconnect, full run with zero network requests'). Bundle everything locally; support Windows/macOS/Linux; WCAG AA contrast; zero console errors."
