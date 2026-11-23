/**
 * electron/preload.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Exposes a narrow, typed API surface to the renderer via contextBridge.
 * Nothing from Node or Electron leaks into the renderer's global scope.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Slide, ProgressEvent, UrlResolveResult, DroppedFile } from '../src/types';

// The Electron tsconfig compiles the main process, so it has no DOM lib. The
// preload is the one file that touches DOM drag events, so the few shapes it
// needs are declared here instead of pulling the whole DOM lib into main.
interface DropDataTransfer {
  types?: readonly string[];
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string }> | null;
  dropEffect?: string;
  getData?(format: string): string;
}
interface DropEvent extends Event {
  dataTransfer?: DropDataTransfer | null;
}
interface PreloadWindow {
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
}
declare const window: PreloadWindow;

// ── Drag & drop plumbing ─────────────────────────────────────────────────────
// The listeners are installed at load time, not when the renderer subscribes:
// the window must never act on a dropped file even for the moment before React
// has mounted, or the drop navigates the window to the file and the app is gone.

type DropSubscriber = (files: DroppedFile[]) => void;
const dropSubscribers = new Set<DropSubscriber>();

/** Record a drag event so a real drop can be diagnosed from the log file. */
function debugDrag(payload: Record<string, unknown>): void {
  try {
    ipcRenderer.send('debug:drag', payload);
  } catch {
    /* diagnostics must never break a drop */
  }
}

/** The file's absolute path, or '' when it has no location on disk. */
function safePath(file: File): string {
  try {
    return webUtils.getPathForFile(file) || (file as File & { path?: string }).path || '';
  } catch {
    return '';
  }
}

/** Data-transfer type list, tolerating a null dataTransfer. */
function dragTypes(dataTransfer: DropDataTransfer | null | undefined): string[] {
  try {
    return Array.from(dataTransfer?.types ?? []);
  } catch {
    return [];
  }
}

/** Read a dataTransfer string, tolerating sources that throw or forbid it. */
function safeData(dataTransfer: DropDataTransfer | null | undefined, format: string): string {
  try {
    return dataTransfer?.getData?.(format) ?? '';
  } catch {
    return '';
  }
}

/**
 * Turn a `text/uri-list` payload into local paths.
 *
 * Some drag sources (archive tools, some file managers, browsers) do not expose
 * `dataTransfer.files` at all and only provide the paths as `file://` URIs.
 */
function pathsFromUriList(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      if (!/^file:\/\//i.test(line)) return '';
      try {
        const decoded = decodeURIComponent(line.replace(/^file:\/\//i, ''));
        // file:///C:/x → /C:/x → C:/x
        return decoded.replace(/^\/([A-Za-z]:)/, '$1');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * Resolve dropped files to paths, materialising the ones that have no path.
 * A file dragged out of a ZIP or an email is virtual: it has bytes but no disk
 * location, so it is written to a temp file rather than dropped on the floor.
 */
async function resolveDroppedFiles(files: File[]): Promise<DroppedFile[]> {
  const resolved: DroppedFile[] = [];

  for (const file of files) {
    const onDisk = safePath(file);
    if (onDisk) {
      resolved.push({ name: file.name, size: file.size, path: onDisk });
      continue;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = (await ipcRenderer.invoke(
        'fs:saveDroppedBytes',
        file.name,
        Array.from(bytes)
      )) as string | null;
      resolved.push({ name: file.name, size: file.size, path: saved ?? '' });
    } catch {
      resolved.push({ name: file.name, size: file.size, path: '' });
    }
  }

  return resolved;
}

/**
 * Accept every drag that enters the window.
 *
 * Chromium only delivers `drop` to a window that cancelled `dragover`, and the
 * set of types a drag advertises differs by source (Explorer, archive tools,
 * browsers, mail clients). Deciding whether a drag "looks like files" before
 * accepting it meant unusual sources were refused outright and silently — the
 * user saw the drag do nothing. The window now accepts any drag and inspects
 * the payload only once the drop arrives.
 */
function onWindowDragOver(event: Event): void {
  const drop = event as DropEvent;
  drop.preventDefault();
  if (drop.dataTransfer) drop.dataTransfer.dropEffect = 'copy';
}

function onWindowDragEnter(event: Event): void {
  const drop = event as DropEvent;
  drop.preventDefault();
  debugDrag({ kind: 'dragenter', types: dragTypes(drop.dataTransfer) });
}

function onWindowDrop(event: Event): void {
  const drop = event as DropEvent;
  const dataTransfer = drop.dataTransfer;
  const files = Array.from(dataTransfer?.files ?? []);
  const uriList = safeData(dataTransfer, 'text/uri-list');

  debugDrag({
    kind: 'drop',
    types: dragTypes(dataTransfer),
    items: dataTransfer ? Array.from(dataTransfer.items ?? []).map((i) => i.kind) : null,
    files: files.map((file) => ({ name: file.name, size: file.size, path: safePath(file) })),
    uriList,
  });

  // Cancel first: an uncancelled drop navigates the window to the file.
  drop.preventDefault();

  if (files.length > 0) {
    void resolveDroppedFiles(files).then((resolved) => {
      debugDrag({ kind: 'resolved', files: resolved.map((f) => ({ name: f.name, path: f.path })) });
      for (const subscriber of dropSubscribers) subscriber(resolved);
    });
    return;
  }

  // No File objects, but the source may still have handed over file:// paths.
  const fromUris = pathsFromUriList(uriList);
  if (fromUris.length > 0) {
    const resolved = fromUris.map((p) => ({
      name: p.split(/[\\/]/).pop() ?? p,
      size: 0,
      path: p,
    }));
    debugDrag({ kind: 'resolved-uris', files: resolved.map((f) => ({ name: f.name, path: f.path })) });
    for (const subscriber of dropSubscribers) subscriber(resolved);
    return;
  }

  // Tell the UI the drag carried nothing usable, so it can say so out loud
  // instead of leaving the user staring at an unchanged window.
  for (const subscriber of dropSubscribers) subscriber([]);
}

window.addEventListener('dragenter', onWindowDragEnter, true);
window.addEventListener('dragover', onWindowDragOver, true);
window.addEventListener('drop', onWindowDrop, true);

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // ── File pickers ────────────────────────────────────────────────────────────
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: (): Promise<string[]> => ipcRenderer.invoke('dialog:openDirectory'),

  // ── Save helpers ────────────────────────────────────────────────────────────
  saveFile: (defaultName: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, ext),
  writeFile: (filePath: string, data: number[]): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', filePath, data),

  // ── Pipeline ────────────────────────────────────────────────────────────────
  runPipeline: (filePaths: string[]): Promise<Slide[]> =>
    ipcRenderer.invoke('pipeline:run', filePaths),

  onPipelineProgress: (
    cb: (msg: ProgressEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, msg: unknown) =>
      cb(msg as ProgressEvent);
    ipcRenderer.on('pipeline:progress', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('pipeline:progress', listener);
  },

  cancelPipeline: (): Promise<void> => ipcRenderer.invoke('pipeline:cancel'),

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  /**
   * Files dropped onto the window, already resolved to absolute paths.
   *
   * Path resolution happens in the preload because that is where a dropped File
   * is still backed by a file on disk. Subscribing also lets the renderer show
   * the queue row; the drop itself is intercepted at load time above, so the
   * window can never navigate away to the dropped document.
   */
  onFilesDropped: (cb: DropSubscriber): (() => void) => {
    dropSubscribers.add(cb);
    return () => {
      dropSubscribers.delete(cb);
    };
  },

  /**
   * Expand dropped paths into documents: folders are walked, unsupported files
   * are dropped. Returns the readable documents only.
   */
  expandPaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('fs:expandPaths', paths),

  /** Host facts, e.g. whether the app is running elevated (drops are blocked). */
  appInfo: (): Promise<{ platform: string; elevated: boolean }> =>
    ipcRenderer.invoke('app:info'),

  // ── Files opened from outside the app ───────────────────────────────────────
  /**
   * Documents the app was launched with, or that were opened onto it while it
   * was running. Windows passes these as command-line arguments, which works
   * even where OLE drag & drop is blocked.
   */
  takePendingOpenPaths: (): Promise<string[]> => ipcRenderer.invoke('files:takePending'),

  onFilesOpened: (cb: (paths: string[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, paths: unknown) =>
      cb(Array.isArray(paths) ? paths.map((p) => String(p)) : []);
    ipcRenderer.on('files:opened', listener);
    return () => ipcRenderer.removeListener('files:opened', listener);
  },

  // Kept for callers that already hold a File in the preload's own world.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── URL fetch → downloads the link's documents to temp files ────────────────
  resolveUrl: (url: string): Promise<UrlResolveResult> =>
    ipcRenderer.invoke('url:resolve', url),
});
