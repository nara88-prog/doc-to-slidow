/**
 * electron/main.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Electron main process entry point.
 * Responsibilities:
 *   - Create and manage the BrowserWindow.
 *   - Register IPC handlers that the renderer calls via the preload bridge.
 *   - Spawn Worker threads for heavy pipeline work (parsing, summarizing).
 *   - Export orchestration: PPTX, PDF, HTML.
 *
 * OFFLINE GUARANTEE: This file never opens an outbound TCP connection.
 * The only network path is the user-initiated URL fetch (ipcMain 'fetch-url').
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Worker } from 'worker_threads';
import { resolveUrlToDocuments } from './net/resolve';
import type { UrlDocument, UrlResolveResult } from '../src/types';

// ── window ────────────────────────────────────────────────────────────────────

/** True when launched by `npm run dev` (vite dev server + electron . --dev). */
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow: BrowserWindow | null = null;

// ── Files handed to the app on the command line ───────────────────────────────
// Windows passes files dropped on a shortcut or taskbar icon, and files opened
// via "Open with", as command-line arguments. That is a genuine alternative to
// OLE drag & drop, which Windows can block outright (elevation, policy, hardened
// shells). Paths that arrive before the window exists are held until it asks.
let pendingOpenPaths: string[] = [];

/** Absolute, existing, supported documents among the given arguments. */
function documentsFromArgv(argv: string[]): string[] {
  const candidates = argv.filter((arg) => {
    if (typeof arg !== 'string' || arg.length === 0) return false;
    if (arg.startsWith('-')) return false;
    // Skip the executable and dev-mode "." — only real absolute paths count.
    return path.isAbsolute(arg);
  });
  return collectSupportedFiles(candidates);
}

function openPathsNow(paths: string[]): void {
  if (paths.length === 0) return;
  pendingOpenPaths.push(...paths);
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('files:opened', paths);
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    // `hiddenInset` is a macOS-only title bar style. Passing it on Windows left
    // the window in an odd non-client state for no benefit — Windows gets its
    // native frame back.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Block any renderer-initiated navigation to external origins
      sandbox: false,
    },
  });

  // Load the Vite dev server in development; bundled index.html in production.
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // DevTools is docked rather than detached: a floating DevTools window can
    // sit over the app and swallow a drag, which reads as "drag and drop is
    // broken". It is still one shortcut away (F12 / Ctrl+Shift+I).
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    // This file lives in dist-electron/electron/, the renderer in dist/.
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Block outbound navigation — keep everything inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // The window must never navigate away from its own page. Dropping a file
  // anywhere but the drop zone is a plain navigation to file://, which replaced
  // the whole UI with the document and left no way back to the app — the user
  // saw "drag and drop doesn't work" and had to relaunch.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (url === current) return;
    event.preventDefault();
    // A real link still deserves to open, just outside the app.
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

// A second launch (including "drag onto the taskbar icon") hands its files to
// the instance that is already running instead of starting a rival copy.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    openPathsNow(documentsFromArgv(argv.slice(1)));
  });

  app.whenReady().then(() => {
    appendDragLog({
      kind: 'startup',
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      elevated: isElevated(),
      userData: app.getPath('userData'),
      argvFiles: documentsFromArgv(process.argv.slice(1)),
    });

    pendingOpenPaths.push(...documentsFromArgv(process.argv.slice(1)));

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: file / directory picker ─────────────────────────────────────────────

/** Extensions the app can read. */
const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.pptx', '.txt', '.md', '.html', '.htm']);

/**
 * Expand paths into a flat list of supported documents.
 *
 * Used by both the folder picker and drag & drop, so dropping a folder behaves
 * exactly like choosing one. Unreadable entries are skipped rather than
 * aborting the whole selection — a drop can include a locked file.
 */
function collectSupportedFiles(inputs: string[]): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();

  function walk(target: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) walk(path.join(target, entry.name));
      return;
    }

    if (!SUPPORTED_EXTS.has(path.extname(target).toLowerCase())) return;
    if (seen.has(target)) return;
    seen.add(target);
    collected.push(target);
  }

  for (const input of inputs) walk(input);
  return collected;
}

ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Documents',
        extensions: ['pdf', 'docx', 'pptx', 'txt', 'md', 'html', 'htm'],
      },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return collectSupportedFiles(result.filePaths);
});

/**
 * Turn dropped paths into documents.
 *
 * A dropped item may be a folder, and a drop may mix folders with files, so the
 * renderer sends raw paths and gets back only what the app can read.
 */
ipcMain.handle('fs:expandPaths', async (_event, paths: string[]) => {
  if (!Array.isArray(paths)) return [];
  return collectSupportedFiles(paths.filter((p) => typeof p === 'string' && p.length > 0));
});

// ── IPC: save export ──────────────────────────────────────────────────────────

ipcMain.handle('dialog:saveFile', async (_event, defaultName: string, ext: string) => {
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('fs:writeFile', async (_event, filePath: string, data: number[]) => {
  fs.writeFileSync(filePath, Buffer.from(data));
});

/**
 * Save a dropped file that has no path of its own.
 *
 * A File dragged out of a ZIP archive or an email attachment is virtual: it has
 * bytes but no location on disk, so webUtils.getPathForFile() returns "". This
 * writes those bytes to a temp file so the pipeline can read it like any other
 * document instead of the drop being silently ignored.
 */
ipcMain.handle('fs:saveDroppedBytes', async (_event, name: string, data: number[]) => {
  try {
    const safeName = path
      .basename(String(name || 'dropped'))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const dir = path.join(os.tmpdir(), 'doc-to-slides-dropped');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(target, Buffer.from(data));
    resolvedTempFiles.add(target);
    return target;
  } catch {
    return null;
  }
});

/**
 * Environment facts the renderer needs in order to explain itself.
 *
 * An elevated process cannot receive file drops from Explorer, so the UI can
 * tell the user why the drop zone is inert instead of leaving them guessing.
 */
ipcMain.handle('app:info', async () => ({
  platform: process.platform,
  elevated: isElevated(),
}));

/**
 * Hand over documents that arrived before the renderer was listening.
 *
 * The renderer calls this once on mount, which removes the race between the
 * window loading and files being opened from the command line.
 */
ipcMain.handle('files:takePending', async () => {
  const paths = pendingOpenPaths;
  pendingOpenPaths = [];
  return paths;
});

/**
 * Drag & drop diagnostics.
 *
 * Real drops cannot be exercised from a test harness, so the preload records
 * every native drag event it sees. The log is appended (never truncated), so the
 * evidence from a failed attempt survives a restart, and it is rotated once it
 * grows past a quarter of a megabyte.
 */
function dragLogPath(): string {
  return path.join(app.getPath('userData'), 'drag-debug.log');
}

function appendDragLog(payload: unknown): void {
  try {
    const file = dragLogPath();
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.rmSync(file, { force: true });
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${JSON.stringify(payload)}\n`);
  } catch {
    /* diagnostics must never break a drop */
  }
}

/**
 * Is this process running with administrator rights?
 *
 * An elevated window cannot receive drag & drop from a normal Explorer window —
 * Windows blocks it across integrity levels — which looks exactly like a broken
 * drop zone. Recording it turns that into a visible explanation.
 *
 * The SAM registry hive is readable only by administrators, so a successful read
 * is a dependable test. (Checking write access to `System32\config` is not: it
 * succeeds for ordinary users.)
 */
function isElevated(): boolean {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }
  try {
    const sam = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'config', 'SAM');
    fs.accessSync(sam, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

ipcMain.on('debug:drag', (_event, payload: unknown) => {
  appendDragLog(payload);
});

// ── IPC: pipeline worker ──────────────────────────────────────────────────────

/**
 * Spawn a Worker thread to run the heavy pipeline (parse → summarize → slides).
 * Progress events are forwarded to the renderer via webContents.send().
 *
 * WATCHDOG: a malformed document can make a parser spin forever. If the worker
 * goes silent for STALL_TIMEOUT_MS, or the whole run exceeds HARD_TIMEOUT_MS,
 * the worker is killed and the run fails with a readable message instead of
 * leaving the UI stuck on "Parsing…".
 */
const STALL_TIMEOUT_MS = 90_000;
const HARD_TIMEOUT_MS = 10 * 60_000;

/** The worker of the run in progress, so the renderer can cancel it. */
let activeWorker: Worker | null = null;

ipcMain.handle('pipeline:cancel', async () => {
  const worker = activeWorker;
  activeWorker = null;
  if (worker) await worker.terminate();
});

ipcMain.handle('pipeline:run', (_event, input: Array<{ path: string; name: string }>) => {
  // Accept plain strings too, so older callers keep working.
  const files = (Array.isArray(input) ? input : []).map((entry) =>
    typeof entry === 'string'
      ? { path: entry, name: path.basename(entry) }
      : { path: entry.path, name: entry.name || path.basename(entry.path) }
  );

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'pipelineWorker.js');
    const worker = new Worker(workerPath, { workerData: { files } });
    activeWorker = worker;

    let settled = false;
    let lastActivity = Date.now();
    let currentFile = '';

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (activeWorker === worker) activeWorker = null;
      fn();
      void worker.terminate();
    };

    const watchdog = setInterval(() => {
      const silentFor = Date.now() - lastActivity;
      if (silentFor > STALL_TIMEOUT_MS) {
        const where = currentFile ? ` while processing "${currentFile}"` : '';
        finish(() => reject(new Error(
          `Processing stalled${where} — the file may be damaged or unusually large. ` +
          `Try a different document.`
        )));
      } else if (silentFor > HARD_TIMEOUT_MS) {
        finish(() => reject(new Error('Processing took too long and was stopped.')));
      }
    }, 2_000);

    worker.on('message', (msg) => {
      lastActivity = Date.now();
      if (msg.type === 'progress') currentFile = msg.file;

      // Forward progress events to renderer
      mainWindow?.webContents.send('pipeline:progress', msg);

      if (msg.type === 'done') {
        finish(() => resolve(Array.isArray(msg.slides) ? msg.slides : []));
      }
      if (msg.type === 'fatalError') {
        finish(() => reject(new Error(msg.message)));
      }
    });

    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`The processing engine stopped unexpectedly (code ${code}).`)));
      }
    });
  });
});

// ── IPC: resolve drag-and-drop file paths ─────────────────────────────────────
// In Electron with contextIsolation, dropped File objects in the renderer
// don't expose their real disk path. webUtils.getPathForFile() solves this.
// See preload.ts for the webUtils.getPathForFile call.

// ── IPC: resolve a pasted link into local documents ───────────────────────────
// This is the ONLY outbound network path in the entire app.
//
// A link can be:
//   • a direct document  → downloaded once, one document returned
//   • a share link       → rewritten to the provider's download endpoint
//   • a listing page     → every document link inside it is downloaded
//                          (one link → many documents)
// Everything is saved to the OS temp folder and handed to the pipeline as a
// normal local file path, so parsing/summarizing stay 100% offline.
//
// The download and content-sniffing logic lives in ./net/resolve so it can be
// exercised on its own; this handler only adapts it to the IPC contract.

/**
 * Temp files handed out by the link resolver.
 *
 * A resolved link can be a folder of 20 PDFs, so these add up to hundreds of
 * megabytes over a session. Nothing else owns them, so the app has to delete
 * them itself — leaving them behind fills the user's temp folder with
 * duplicates of documents they already have.
 */
const resolvedTempFiles = new Set<string>();

function releaseResolvedTempFiles(): void {
  for (const file of resolvedTempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone, or still open */
    }
  }
  resolvedTempFiles.clear();
}

app.on('will-quit', releaseResolvedTempFiles);

ipcMain.handle('url:resolve', async (_event, rawUrl: string): Promise<UrlResolveResult> => {
  try {
    const outcome = await resolveUrlToDocuments(rawUrl);

    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error ?? 'No documents were found at that link.',
        warnings: outcome.warnings,
      };
    }

    const documents: UrlDocument[] = (outcome.documents ?? []).map((doc) => {
      resolvedTempFiles.add(doc.tmpPath);
      return {
        name: doc.name,
        tmpPath: doc.tmpPath,
        size: doc.size,
        url: doc.url,
      };
    });

    return { ok: true, documents, warnings: outcome.warnings };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
});
