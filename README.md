# Doc to Slides

> **Convert any pile of documents into a polished slide deck — 100% offline.**

PDF, DOCX, PPTX, TXT, Markdown, and HTML → one catchy deck, zero cloud.

---

## Table of Contents

1. [Tech Stack & Rationale](#tech-stack--rationale)
2. [Folder Structure](#folder-structure)
3. [Requirements](#requirements)
4. [Install](#install)
5. [Run (Development)](#run-development)
6. [Build (Production)](#build-production)
7. [Offline Verification Checklist](#offline-verification-checklist)
8. [Acceptance Criteria](#acceptance-criteria)

---

## Tech Stack & Rationale

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 31** | Gives full Node.js access for file I/O, Worker threads, and spawning child processes (Ollama), without any mandatory network dependency. Ships on Windows, macOS, and Linux from one codebase. |
| UI framework | **React 18 + Vite 5** | Vite produces small, deterministic bundles with no CDN fetches at build or runtime. React's component model maps cleanly to the three-step flow. |
| Language | **TypeScript** | Typed interfaces enforce the contracts between pipeline stages (parsers → summarizer → slides). |
| PDF parsing | **pdf-parse** | Pure JS, no native binaries required, runs inside a Worker thread. |
| DOCX parsing | **mammoth** | Battle-tested Word→text extraction, pure JS. |
| PPTX parsing | **adm-zip** (ZIP+XML) | PPTX is a ZIP; reading DrawingML text runs requires no extra native library. |
| MD/HTML | **marked** + regex | Lightweight; both convert to plain text in a few milliseconds. |
| Summarizer | **Built-in TF-IDF** (pure JS) | Always works, no binary, deterministic. Optional Ollama upgrade auto-detected. |
| PPTX export | **pptxgenjs** | Runs client-side/Node, produces valid `.pptx`, fully vendored. |
| PDF export | Native print dialog | Avoids bundling headless Chromium (~150 MB). Users select "Save as PDF" in the OS print dialog. |
| HTML export | Inline JS/CSS template | Single file, arrow-key navigation, zero dependencies. |

**Why not Tauri?** Tauri's Rust core is excellent for small bundles, but file parsing and Worker thread spawning in the Node ecosystem are simpler here. Electron's well-known security model (contextIsolation + preload) keeps document contents off the network.

---

## Folder Structure

```
doc-to-slides/
├── electron/                   # Electron main-process code (Node.js / CommonJS)
│   ├── main.ts                 # Window creation, IPC handlers
│   ├── preload.ts              # contextBridge API surface
│   ├── pipelineWorker.ts       # Worker thread: parse → summarize → slides
│   ├── parsers/
│   │   ├── index.ts            # Dispatcher
│   │   ├── pdf.ts              # pdf-parse
│   │   ├── docx.ts             # mammoth
│   │   ├── pptx.ts             # adm-zip XML extraction
│   │   ├── txt.ts              # fs.readFileSync
│   │   ├── md.ts               # marked
│   │   └── html.ts             # regex strip
│   ├── summarizer/
│   │   ├── index.ts            # Dispatcher (Ollama → TF-IDF fallback)
│   │   ├── extractive.ts       # TF-IDF / TextRank (pure JS)
│   │   ├── ollama.ts           # Optional LLM via localhost:11434
│   │   └── merge.ts            # Deduplicate + order multiple summaries
│   └── slides/
│       └── generator.ts        # Outline → Slide[]
│
├── src/                        # React renderer (Vite + TypeScript)
│   ├── types.ts                # Shared interfaces
│   ├── main.tsx                # React root
│   ├── App.tsx                 # Three-step flow
│   ├── index.css               # Design tokens
│   ├── ui/
│   │   ├── StepBar.tsx/.css    # Top navigation
│   │   ├── AddStep.tsx/.css    # Step 1: input + queue
│   │   ├── ReviewStep.tsx/.css # Step 2: editor + themes
│   │   ├── PresentStep.tsx/.css# Step 3: present + export
│   │   └── Toast.tsx/.css      # Notification toasts
│   └── export/
│       ├── pptx.ts             # pptxgenjs → ArrayBuffer
│       ├── html.ts             # Standalone HTML template
│       └── pdf.ts              # Native print dialog
│
├── index.html                  # Vite entry point
├── vite.config.ts
├── tsconfig.json               # Renderer TS config
├── tsconfig.electron.json      # Main-process TS config
└── package.json
```

---

## Requirements

- **Node.js 20+** (LTS recommended — required for `fetch` built-in used in Electron)
- **npm 9+** or **pnpm 8+**
- Windows 10/11, macOS 12+, or Ubuntu 22+

> **Internet is NOT required at runtime.** Internet is only needed once during `npm install` to download packages.

---

## Install

```bash
cd doc-to-slides
npm install
```

That's it. All runtime dependencies are vendored in `node_modules/`. After install, **disconnect Wi-Fi** and the app still runs.

### Optional: Ollama (LLM upgrade)

If you want higher-quality AI summarization:

```bash
# Install Ollama from https://ollama.ai (download their installer)
ollama pull mistral
ollama serve          # starts on localhost:11434
```

The app auto-detects Ollama. If it's not running, the built-in TF-IDF summarizer is used silently.

---

## Run (Development)

**Easiest — double-click `dev.cmd`** (or run it from any terminal). It installs dependencies on first run and starts everything.

Or, from a terminal:

```bash
npm run dev
```

This starts the Vite dev server on `localhost:5173` and launches Electron pointing to it. Hot-module replacement works for the renderer; restart the command to pick up changes to Electron main-process code.

> **Windows PowerShell note:** if you see *"npm.ps1 cannot be loaded because running scripts is disabled"*, use `dev.cmd` or call `npm.cmd run dev` instead. This is a Windows execution-policy setting, not an app problem.

> **Port conflict:** the dev server uses port 5173. If another project already owns it, stop that project first — otherwise the Electron window will show the *other* app's UI while you think you're testing this one.

---

## Build (Production)

**Easiest — double-click `build.cmd`** (builds, then launches the packaged app).

Or, from a terminal:

```bash
npm run build
```

Outputs:
- `dist/` — Vite-bundled renderer
- `dist-electron/` — compiled Electron main process
- `release/win-unpacked/` — ready-to-run app (`Doc to Slides.exe`)

For a distributable installer, run `npm run build:installer`.

### Testing

```bash
npm test           # all three suites
npm run test:url   # link resolver only
npm run test:deck  # outline → deck only
npm run test:export # PPTX / HTML export only
```

`test:url` starts a local server that imitates the awkward cases (download endpoints with no filename, `octet-stream` bodies, meta-declared PDFs, session cookies, sign-in walls, folder pages, browser-UA blocking, Drive folders and the Drive virus-scan page) and asserts what each link resolves to.

`test:deck` checks the deck itself: it grows with the number of documents, keeps its cover and closing slide, never produces a fragment as a title, and never lets one slide mix two source documents.

`test:export` builds a real deck and exports it, then verifies the PPTX is a valid zip with one slide part per slide and the HTML file is self-contained with the whole deck embedded.

The release package is fully self-contained. Copy it to any machine with Wi-Fi disabled and it will run.

> **"app.asar is being used by another process":** an antivirus scanner or a still-running copy of the app is holding the file. Close the app (and wait a few seconds for the scanner) before rebuilding.

---

## Robustness & Failure Handling

Because documents come from arbitrary sources, every stage has a bounded wait — nothing can leave the UI stuck on "Parsing…":

| Situation | Behaviour |
|---|---|
| Link is a direct document | Downloaded once; the file type comes from the bytes, not the URL (`/download?id=42` is recognised as a PDF) |
| Link is a share link | Google Drive/Docs/Slides, Dropbox and OneDrive links are rewritten to their download endpoint instead of the HTML viewer |
| Link is a **Google Drive folder** | The folder is listed and every document inside it is downloaded as its own queue item; sub-folders are followed two levels deep |
| Drive folder is not shared publicly | Reported as *"not shared publicly"* with the exact setting to change, instead of failing silently |
| Drive serves a "can't scan this file for viruses" page | The page's own download form is submitted, so large files still come through |
| Link is an abstract/article page | The PDF declared by the page (`citation_pdf_url`, `<link rel=alternate>`) is fetched — not the page itself |
| Link is a listing page with several documents | Each document is downloaded in parallel and added as its own queue item |
| Link points at a folder page | Sub-pages are followed one level deep — but only when the page itself linked no document, so a "recent posts" sidebar cannot drag in unrelated files |
| Link unreachable / 404 / offline | The queue row shows a readable error plus a **Retry** button |
| Link is behind a sign-in or preview wall | Reported as *"opened a web page instead of the file"* instead of saving the login page as a bogus PDF |
| The same file comes from two links | Queued once — identity is name + size, not the URL or the temp path |
| A download is slow but alive | Never interrupted: the body has a stall timer reset on every chunk, so a 24 MB PDF is not cut off for being large |
| A download stops responding | Abandoned after 30 s of silence, then retried up to twice with a pause |
| A host never answers | 45 s to start answering, then a readable error |
| A whole link hangs | 180 s budget for the link, then a warning naming what was skipped |
| File has no extractable text (scanned PDF) | The row fails with *"has no readable text"* — the app stays on step 1 |
| One document in a batch fails | The rest still process; the failed row is marked and retryable |
| Parser hangs on a damaged file | Per-stage timeout (60 s parse / 90 s summarize), then a readable error |
| Worker goes silent for 90 s | Watchdog kills it and reports which file stalled |
| Pipeline throws before any progress | Every row in that run is marked as failed — never left "Queued" or "Parsing…" |
| User wants out | **Cancel** button terminates the worker and marks rows as cancelled |
| A file is dropped anywhere in the window | Accepted — the whole window is a drop target, and the window never navigates to the dropped document |
| A folder is dropped | Walked recursively, exactly like the folder picker |
| A dropped file's location cannot be read | The file's bytes are written to a temp file instead, so files dragged out of a ZIP or an email still work |
| A drag carries only `text/uri-list` | The `file://` paths in it are used, so sources that expose no `File` objects still work |
| A drag carries no files at all | The user is told so in a toast, instead of the window silently doing nothing |
| The same file is dropped twice | Not duplicated — drops are de-duplicated against the queue by absolute path |
| A native drag reports no file types mid-drag | Still accepted: the window cancels `dragover` for *any* drag, because Chromium only delivers `drop` for a cancelled `dragover` |
| Files are opened onto the app (shortcut, taskbar icon, **Open with**) | Queued and expanded exactly like a drop — a second launch hands its files to the running instance and exits |
| The app is launched with a folder as an argument | Walked recursively, same as the folder picker |

### When Windows refuses to deliver a drop

Windows can block OLE drag & drop before the app ever sees it (an elevated app,
an elevated Explorer, a policy, or a hardened shell). The app cannot fix that from
inside, so it offers routes that do not depend on OLE:

- **Click the drop card** — it is a real button and opens the file picker.
- **Select Files** — the ordinary picker.
- **Drag the file onto the app's taskbar icon or shortcut** — Windows passes the
  paths as command-line arguments. A second launch hands them to the running
  instance and quits, so the queue fills in the window that is already open.
- **Right-click → Open with → Doc to Slides** — same command-line route.

All four are verified by the acceptance suite.

### Diagnosing a drag & drop problem

Every launch and every native drag event is appended to
`%APPDATA%\doc-to-slides\drag-debug.log` (macOS/Linux: the app's `userData`
folder). The log is never truncated, so evidence from a failed attempt survives a
restart.

Read it from the bottom up:

- **A `"kind":"startup"` line with `"elevated":true`** — the app is running as
  administrator. Windows blocks file drops between different integrity levels, so
  an elevated app cannot receive drops from a normal Explorer window. The app
  also says so on the drop card. Restart it normally, or use **Select Files**.
- **`startup` but no `dragenter` line after a drop** — Windows never delivered the
  drag to the window. This is an OS-level block, not an app bug: check for an
  elevated app, a window that is actually a different process, or drag & drop
  being disabled by policy.
- **A `"kind":"drop"` line** — the window received the drag; the `types`, `files`
  and `uriList` fields show exactly what it carried.
- **A `"kind":"resolved"` line** — the paths handed to the pipeline.

---

## Offline Verification Checklist

Follow these steps to confirm **zero network requests** during a full document-to-deck run:

1. **Build the production app** (`npm run build`) or use `npm run dev`.
2. Open the app. Open **DevTools** (`Ctrl+Shift+I` / `Cmd+Option+I`).
3. Go to the **Network** tab → check **Disable cache** → set throttle to **Offline**.
4. Add two or three local documents (PDF + DOCX + TXT) using the Browse or Drag-and-drop methods.
5. Click **Generate Slides**.
6. Watch the Network tab — confirm **0 requests** appear during the entire pipeline run.
7. Navigate to Step 2 (Review) and edit a slide — still 0 requests.
8. Navigate to Step 3 (Present) and export to PPTX and HTML — still 0 requests.
9. *(PPTX)* Open the exported `.pptx` in PowerPoint or LibreOffice — it should contain all slides.
10. *(HTML)* Open the exported `.html` in a browser with Wi-Fi disabled — it must render and navigate correctly.

> **URL fetch path:** Pasting links uses Node's built-in `fetch` in the main process. A link may point to a single document, to a share link (Google Drive/Docs/Slides, Dropbox, OneDrive), to an article/abstract page that declares its PDF in metadata, or to a listing/folder page — every document found is downloaded into the OS temp folder and enqueued as its own item, so the pipeline only ever sees local files. The file type is decided by the bytes received (magic numbers) plus `Content-Disposition`, never by the URL extension alone, and pages are only crawled when they link no document themselves. Downloads are bounded by a *stall* timer rather than a total-time cap, so a large document is never abandoned for being large, and the temp files are deleted when the app quits. With "Offline" mode in DevTools, link resolution fails gracefully with a readable message and a Retry button instead of crashing the app.

---

## Acceptance Criteria

Use this checklist to sign off on the delivered application:

### Input
- [ ] File picker opens and accepts multi-select of PDF, DOCX, PPTX, TXT, MD, HTML files
- [ ] Directory picker recursively collects all supported files from a folder
- [ ] Dragging files over the window highlights the drop area, and dropping anywhere in the window adds them
- [ ] Clicking the drop card opens the file picker (so it is never a dead end)
- [ ] A dropped folder adds every supported document inside it
- [ ] Dropping a file outside the drop area never navigates the window away from the app
- [ ] Unsupported file types dropped show a human-readable error toast
- [ ] Dragging a file onto the app's taskbar icon or shortcut queues it in the running window
- [ ] Opening a file with the app queues it; a second launch never opens a rival window
- [ ] URL field accepts multiple lines; each line is resolved immediately
- [ ] A direct document link (`.../report.pdf`, `/download?id=42`, `/pdf/123`) yields exactly one queue item
- [ ] An arXiv-style abstract page yields the paper's PDF, not the abstract page
- [ ] A listing page expands into one queue item per document found
- [ ] A page that links no document (a folder) is followed one level deep; a page that already links one is not crawled
- [ ] A Google Drive / Docs / Slides share link downloads the file rather than the viewer page
- [ ] A **Google Drive folder** link adds every document inside it, one queue item each
- [ ] A Drive folder that is not public says so, and names the setting to change
- [ ] A native Google Doc/Slides inside a folder arrives as `.docx` / `.pptx`
- [ ] A Drive file big enough to trigger the virus-scan page still downloads
- [ ] A sign-in wall is reported as such, never saved as a bogus document
- [ ] Pasting a folder link **and** a link to one file inside it queues that file once
- [ ] A large document (20 MB+) downloads completely instead of failing with "The link timed out"
- [ ] The progress bar keeps moving while a folder is being downloaded
- [ ] Offline/unreachable links show a readable error with a Retry button instead of crashing

### Queue
- [ ] Each queue item shows: filename, size, status badge, progress bar
- [ ] Statuses cycle correctly: queued → parsing → summarizing → done
- [ ] Error items show the human-readable error message (e.g., "password-protected")
- [ ] Retry button re-queues an errored item
- [ ] Remove (✕) button removes an item from the queue
- [ ] "Clear All" empties the queue

### Processing
- [ ] 50-page PDF summarizes in under 10 seconds on a mid-range laptop
- [ ] UI remains responsive during processing (not frozen)
- [ ] Multiple files from different sources (mixed queue) produce one unified deck
- [ ] App does NOT crash if Ollama is absent — falls back to TF-IDF silently
- [ ] A failing run marks its rows as Error — never stuck on "Parsing…"
- [ ] Cancel button stops a run in progress
- [ ] A damaged/hanging file times out with a readable message instead of freezing

### Text & Summary Quality
- [ ] Extracted PDF text contains no glued words (`inimenjadikanfunctionsegala`) and no doubled spaces
- [ ] A hyphen split across a line break keeps its meaning: `sequence-\naligned` stays `sequence-aligned`, `transduc-\ntion` becomes `transduction`
- [ ] Bullets are complete clauses — never cut mid-phrase (`… are related to`, `… be prepared to either live`, `… parsing both with large`)
- [ ] Numeric citation markers (`[21]`, `[4, 27, 28]`) never appear in bullets
- [ ] Parentheses are balanced in both titles and bullets — no stray `)` or unclosed `(`
- [ ] Slide titles are real noun phrases — never citation strings (`A Wahyudi M Kafrawi M`) or the first seven words of a sentence
- [ ] Bibliography, acknowledgements, licence text, publisher front matter and page furniture never reach a slide
- [ ] A slide-deck PDF (text with no full stops) still yields one bullet per line instead of a single run-on
- [ ] Mixed English/Indonesian documents keep both languages readable, with correct spacing in each
- [ ] The deck always has a cover slide, content slides, and a closing "Key Takeaways" slide
- [ ] The deck grows with the input: five documents produce a longer deck than one, not one slide per document
- [ ] Every content slide carries 2–5 bullets, so no slide is a bare heading
- [ ] No slide title is a clause fragment (`Ketika Pengguna`, `Struktur Ini Memungkinkan Kita`, `…, Mulai`)
- [ ] A slide never mixes two source documents — its bullets all come from one file

### Slide Workspace
- [ ] Generated slides have: punchy title, 3–5 bullets, speaker notes, icon
- [ ] Title, bullets, and speaker notes are all editable inline
- [ ] Add slide inserts a new blank slide after the selected one
- [ ] Delete slide removes the selected slide (disabled when only 1 slide remains)
- [ ] Duplicate slide creates a copy immediately after the selected one
- [ ] Slides can be reordered by drag-and-drop
- [ ] 5 built-in themes are available; switching themes updates the live preview instantly

### Present Mode
- [ ] Fullscreen mode launches and covers the entire screen
- [ ] Arrow keys (← →) navigate between slides
- [ ] ESC exits fullscreen
- [ ] Speaker notes are visible at the bottom in fullscreen
- [ ] Slide strip allows click-to-jump in normal (non-fullscreen) view

### Export
- [ ] PPTX export: file saved, opens in PowerPoint/LibreOffice with correct slide count and content
- [ ] HTML export: standalone file navigates with arrow keys, renders offline
- [ ] PDF export: system print dialog opens; "Save as PDF" produces a readable file

### Offline / Privacy
- [ ] Network tab shows 0 requests during a full local document-to-deck run
- [ ] App launches with Wi-Fi disabled (after one-time `npm install`)
- [ ] No document content is logged to console or written outside the app's working directory

### Accessibility
- [ ] All interactive elements reachable by Tab / Shift+Tab
- [ ] Focus rings visible on all focusable elements
- [ ] ARIA labels present on queue items, buttons, and progress bars
- [ ] Color contrast meets WCAG AA (4.5:1 for normal text) in both dark and light themes
- [ ] Screen reader announces queue status changes via `role="status"` / `aria-live`

### Cross-platform
- [ ] Builds and runs on Windows 10/11
- [ ] Builds and runs on macOS 12+
- [ ] Builds and runs on Ubuntu 22+
