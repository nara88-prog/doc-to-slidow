/**
 * src/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TypeScript interfaces used by both the Electron main process and
 * the React renderer.  These are the typed contracts between pipeline stages.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Queue item (renderer state) ───────────────────────────────────────────────

export type QueueItemStatus =
  | 'queued'
  | 'parsing'
  | 'summarizing'
  | 'done'
  | 'error'
  | 'cancelled';

export interface QueueItem {
  id: string;
  name: string;
  /** Absolute file path (for local files) or the original URL. */
  source: string;
  /**
   * For URL-sourced items: the local temp file the link was downloaded to.
   * A single link may resolve into several items (one per document found).
   */
  resolvedPath?: string;
  /** Bytes; undefined for URL-sourced items until download is complete. */
  size?: number;
  status: QueueItemStatus;
  errorMessage?: string;
  /** 0–100 progress percentage. */
  progress: number;
}

// ── URL resolution (main → renderer) ─────────────────────────────────────────

/** One document discovered behind a pasted link. */
export interface UrlDocument {
  /** Human-readable file name (e.g. "report.pdf"). */
  name: string;
  /** Local temp file the document was downloaded to. */
  tmpPath: string;
  size: number;
  /** The direct URL the document was fetched from. */
  url: string;
}

export interface UrlResolveResult {
  ok: boolean;
  /** Present when ok === false. */
  error?: string;
  /** Documents found behind the link (1 for a direct file link, N for a listing page). */
  documents?: UrlDocument[];
  /** Non-fatal problems, e.g. individual links inside a page that failed. */
  warnings?: string[];
}

// ── Slide ─────────────────────────────────────────────────────────────────────

export type SlideType = 'title' | 'content' | 'conclusion';

export interface Slide {
  id: string;
  type: SlideType;
  title: string;
  bullets: string[];
  notes: string;
  icon: string;
}

// ── Pipeline progress events (Worker → Main → Renderer) ──────────────────────

/** A document handed to the pipeline worker. */
export interface PipelineFile {
  /** Absolute local path (downloaded temp file for URL sources). */
  path: string;
  /** Display name shown in the UI (original file name / URL file name). */
  name: string;
}

export type ProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; index: number; file: string; stage: 'parsing' | 'summarizing' | 'done' }
  | { type: 'error'; index: number; file: string; message: string }
  | { type: 'merging' }
  | { type: 'generating' }
  | { type: 'done'; slides: Slide[] }
  | { type: 'fatalError'; message: string };

// ── Theme ─────────────────────────────────────────────────────────────────────

export interface Theme {
  id: string;
  name: string;
  bg: string;
  surface: string;
  text: string;
  accent: string;
  headingFont: string;
}

// ── App step ─────────────────────────────────────────────────────────────────

export type AppStep = 'add' | 'review' | 'present';

// ── Electron API (exposed via preload contextBridge) ──────────────────────────

/** A file dropped onto the window, already resolved to its absolute path. */
export interface DroppedFile {
  name: string;
  size: number;
  /** Empty when the file's location could not be read. */
  path: string;
}

export interface ElectronAPI {
  /** `process.platform` of the host — used to pick platform-specific UI. */
  platform: string;
  openFiles(): Promise<string[]>;
  openDirectory(): Promise<string[]>;
  saveFile(defaultName: string, ext: string): Promise<string | null>;
  writeFile(filePath: string, data: number[]): Promise<void>;
  runPipeline(files: PipelineFile[]): Promise<Slide[]>;
  onPipelineProgress(cb: (msg: ProgressEvent) => void): () => void;
  /** Stop a running pipeline run (the worker thread is terminated). */
  cancelPipeline(): Promise<void>;
  /**
   * Subscribe to files dropped onto the window. Paths are resolved in the
   * preload, because a File sent through contextBridge loses its disk path.
   * Returns an unsubscribe function.
   */
  onFilesDropped(cb: (files: DroppedFile[]) => void): () => void;
  /** Expand dropped paths: folders are walked, unsupported files are dropped. */
  expandPaths(paths: string[]): Promise<string[]>;
  /** Host facts, e.g. whether the app is elevated (Windows blocks drops then). */
  appInfo(): Promise<{ platform: string; elevated: boolean }>;
  /** Documents the app was launched with, or opened onto it while running. */
  takePendingOpenPaths(): Promise<string[]>;
  /** Subscribe to files opened onto the running app. Returns an unsubscribe. */
  onFilesOpened(cb: (paths: string[]) => void): () => void;
  getPathForFile(file: File): string;
  /**
   * Download a link into local temp files.
   * A direct document link yields one document; a listing page yields every
   * document it links to. This is the only network-dependent call in the app.
   */
  resolveUrl(url: string): Promise<UrlResolveResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
