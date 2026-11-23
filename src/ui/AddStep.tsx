/**
 * src/ui/AddStep.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 1: Three input methods (browse, drag-drop, paste URL) + queue management.
 *
 * URL handling: a pasted link is resolved by the main process into one or more
 * local documents (a listing page can contain many). Each discovered document
 * becomes its own queue item with a `resolvedPath`, so the pipeline only ever
 * receives real local files.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { QueueItem, QueueItemStatus, Slide, ProgressEvent } from '../types';
import type { ToastKind } from './Toast';
import styles from './AddStep.module.css';

interface Props {
  queue: QueueItem[];
  onQueueChange: React.Dispatch<React.SetStateAction<QueueItem[]>>;
  onSlidesReady: (slides: Slide[]) => void;
  showToast: (msg: string, kind?: ToastKind) => void;
}

let _qid = 0;
function newId() { return String(++_qid); }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SUPPORTED_EXTS = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.html', '.htm'];

function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTS.some((e) => lower.endsWith(e));
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * Electron prefixes IPC rejections with
 *   "Error invoking remote method 'pipeline:run': Error: <real message>"
 * which is noise for a non-technical user. Strip it down to the real cause.
 */
function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || 'Unknown error';
}

const STATUS_LABEL: Record<QueueItemStatus, string> = {
  queued: 'Queued',
  parsing: 'Parsing…',
  summarizing: 'Summarizing…',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
};

export function AddStep({ queue, onQueueChange, onSlidesReady, showToast }: Props) {
  const [urls, setUrls] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [resolvingCount, setResolvingCount] = useState(0);
  /** True when Windows will refuse drops because the app runs as administrator. */
  const [dropsBlocked, setDropsBlocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  /** Queue item ids that belong to the run in progress (for failure reporting). */
  const runItemIdsRef = useRef<string[]>([]);

  // Mirror of the queue so async handlers always read the latest items.
  const queueRef = useRef(queue);
  useEffect(() => { queueRef.current = queue; }, [queue]);

  // ── Helpers (all functional updates — no stale-state overwrites) ───────────

  const addItems = useCallback((newItems: QueueItem[]) => {
    onQueueChange((prev) => [...prev, ...newItems]);
  }, [onQueueChange]);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    onQueueChange((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, [onQueueChange]);

  const removeItem = useCallback((id: string) => {
    onQueueChange((prev) => prev.filter((item) => item.id !== id));
  }, [onQueueChange]);

  // ── Browse ────────────────────────────────────────────────────────────────

  const handleBrowseFiles = async () => {
    const paths = await window.electronAPI.openFiles();
    if (!paths.length) return;
    const items: QueueItem[] = paths.map((p) => ({
      id: newId(),
      name: p.split(/[\\/]/).pop() ?? p,
      source: p,
      status: 'queued',
      progress: 0,
    }));
    addItems(items);
  };

  const handleBrowseDirectory = async () => {
    const paths = await window.electronAPI.openDirectory();
    if (!paths.length) {
      showToast('No supported files found in that folder.', 'info');
      return;
    }
    const items: QueueItem[] = paths.map((p) => ({
      id: newId(),
      name: p.split(/[\\/]/).pop() ?? p,
      source: p,
      status: 'queued',
      progress: 0,
    }));
    addItems(items);
    showToast(`Added ${items.length} file${items.length !== 1 ? 's' : ''} from folder.`, 'success');
  };

  // ── Drag & Drop ───────────────────────────────────────────────────────────
  // The drop itself is handled in the preload (see preload.ts): only there is a
  // dropped File still tied to a file on disk, so only there can its absolute
  // path be read. This component subscribes to the resolved paths instead.

  const addPaths = useCallback(
    (paths: string[], note?: string) => {
      // Ignore anything already queued, so a second drop does not duplicate.
      const known = new Set(
        queueRef.current.map((q) => q.resolvedPath ?? q.source).filter(Boolean)
      );
      const fresh = paths.filter((p) => !known.has(p));

      if (fresh.length === 0) {
        showToast('Those files are already in the queue.', 'info');
        return;
      }

      addItems(
        fresh.map((p) => ({
          id: newId(),
          name: p.split(/[\\/]/).pop() ?? p,
          source: p,
          status: 'queued' as const,
          progress: 0,
        }))
      );
      showToast(
        `Added ${fresh.length} file${fresh.length === 1 ? '' : 's'}${note ? ` ${note}` : ''}.`,
        'success'
      );
    },
    [addItems, showToast]
  );

  // Files opened from outside the app — launched with them, or dropped onto the
  // shortcut/taskbar icon. Windows hands these over as arguments, which still
  // works where OLE drag & drop is blocked.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.takePendingOpenPaths) return;

    let cancelled = false;

    const ingest = async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const expanded = await api.expandPaths(paths);
        if (!cancelled && expanded.length > 0) addPaths(expanded);
      } catch {
        /* the user can still add files manually */
      }
    };

    void api
      .takePendingOpenPaths()
      .then((paths) => ingest(paths))
      .catch(() => {
        /* diagnostics only */
      });

    const unsubscribe = api.onFilesOpened?.((paths) => void ingest(paths));

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [addPaths]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.appInfo) return;

    let cancelled = false;
    void api
      .appInfo()
      .then((info) => {
        if (!cancelled) setDropsBlocked(info.platform === 'win32' && info.elevated);
      })
      .catch(() => {
        /* diagnostics only */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onFilesDropped) return;

    return api.onFilesDropped(async (files) => {
      // An empty list means the drop carried no files at all (plain text, an
      // image snippet, or a source that hands over nothing usable). Saying so
      // is far better than leaving the window unchanged and looking broken.
      if (files.length === 0) {
        showToast(
          'That drag did not contain any files. Drag files from File Explorer, or use Select Files.',
          'error'
        );
        return;
      }

      // A File whose location cannot be read would otherwise enter the queue as
      // a bare filename and fail later at the parsing stage.
      const resolved = files.filter((f) => f.path);
      const unreadable = files.length - resolved.length;

      if (resolved.length === 0) {
        showToast(
          "Couldn't read where those files live — use Select Files instead.",
          'error'
        );
        return;
      }

      try {
        // Folders are walked here, exactly like the folder picker.
        const paths = await api.expandPaths(resolved.map((f) => f.path));
        if (paths.length === 0) {
          showToast(
            'No supported file types in drop. Try PDF, DOCX, PPTX, TXT, MD, or HTML.',
            'error'
          );
          return;
        }
        addPaths(paths, unreadable > 0 ? `(${unreadable} unreadable)` : undefined);
      } catch (err) {
        showToast(`Could not read the dropped files: ${(err as Error).message}`, 'error');
      }
    });
  }, [addPaths, showToast]);

  // Highlight the drop zone while a file is over the window. A counter is
  // needed because dragging across child elements fires leave/enter pairs.
  useEffect(() => {
    let depth = 0;

    // Chromium can report an empty type list mid-drag, so an empty list counts
    // as a possible file drag — otherwise the zone never lights up.
    const maybeFileDrag = (event: DragEvent): boolean => {
      const dt = event.dataTransfer;
      if (!dt) return false;
      const types = Array.from(dt.types ?? []);
      return types.length === 0 || types.includes('Files');
    };

    const onEnter = (event: DragEvent) => {
      if (!maybeFileDrag(event)) return;
      depth += 1;
      setIsDragOver(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!maybeFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragOver(false);
    };
    const onDrop = () => {
      depth = 0;
      setIsDragOver(false);
    };
    // A drop that ends outside the window never fires leave, so reset on any
    // dragend/blur too or the zone stays lit forever.
    const onReset = () => {
      depth = 0;
      setIsDragOver(false);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onReset);
    window.addEventListener('blur', onReset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onReset);
      window.removeEventListener('blur', onReset);
    };
  }, []);

  // Fallback for running the renderer outside Electron (tests, browser preview).
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // In Electron the preload already handled this drop (and stopped it from
    // propagating), so this path only runs in a plain browser.
    if (typeof window.electronAPI?.onFilesDropped === 'function') return;

    const files = Array.from(e.dataTransfer.files).filter((f) =>
      isSupportedFile(f.name)
    );
    if (files.length === 0) {
      showToast('No supported file types in drop. Try PDF, DOCX, PPTX, TXT, MD, or HTML.', 'error');
      return;
    }
    const items: QueueItem[] = files.map((f) => ({
      id: newId(),
      name: f.name,
      // Use Electron's webUtils.getPathForFile to get the real absolute path.
      // Falls back to the file name if running outside Electron (e.g. tests).
      source: window.electronAPI?.getPathForFile(f) || f.name,
      size: f.size,
      status: 'queued',
      progress: 0,
    }));
    addItems(items);
    showToast(`Added ${items.length} file${items.length !== 1 ? 's' : ''}.`, 'success');
  };

  // ── URL resolution ────────────────────────────────────────────────────────

  /**
   * Download one pasted link. Returns the queue items that were discovered
   * (one per document behind the link) so callers can use them immediately.
   */
  const resolveLinkItem = useCallback(async (item: QueueItem): Promise<QueueItem[]> => {
    if (!navigator.onLine) {
      updateItem(item.id, {
        status: 'error',
        progress: 0,
        errorMessage: 'You are offline — reconnect, then click retry.',
      });
      return [];
    }

    updateItem(item.id, { status: 'parsing', progress: 10, errorMessage: undefined });
    setResolvingCount((n) => n + 1);

    // A Drive folder of large PDFs can take half a minute. A bar frozen at 10%
    // reads as a hang, so let it crawl towards 88% while the download is in
    // flight. It never reaches 100 by itself — finishing is the real signal.
    let shown = 10;
    const crawl = window.setInterval(() => {
      if (shown >= 88) return;
      shown = Math.min(88, shown + Math.max(1, Math.round((88 - shown) / 6)));
      updateItem(item.id, { progress: shown });
    }, 1000);

    try {
      const result = await window.electronAPI.resolveUrl(item.source);
      const docs = result.documents ?? [];

      if (!result.ok || docs.length === 0) {
        updateItem(item.id, {
          status: 'error',
          progress: 0,
          errorMessage: result.error ?? 'No documents were found at that link.',
        });
        return [];
      }

      // Skip documents that are already in the queue. Two different links can
      // point at the same file (a Drive folder plus a link to one file inside
      // it), and neither the temp path nor the URL identifies it reliably: the
      // temp path is new on every download, and the URL differs by which code
      // path fetched it (a folder records the `uc?export=download` endpoint, a
      // direct link records the post-redirect `usercontent` URL). Name plus
      // byte size is stable across both.
      const identity = (name: string, size: number): string =>
        `${name.trim().toLowerCase()}|${size}`;

      const alreadyQueued = new Set(
        queueRef.current
          .filter((q) => q.resolvedPath && typeof q.size === 'number')
          .map((q) => identity(q.name, q.size as number))
      );

      const discovered: QueueItem[] = docs
        .filter((d) => !alreadyQueued.has(identity(d.name, d.size)))
        .map((d) => ({
          id: newId(),
          name: d.name,
          source: d.url,
          resolvedPath: d.tmpPath,
          size: d.size,
          status: 'queued',
          progress: 0,
        }));

      // Replace the placeholder URL row with the documents it contains.
      onQueueChange((prev) => {
        const index = prev.findIndex((q) => q.id === item.id);
        if (index === -1) return [...prev, ...discovered];
        return [...prev.slice(0, index), ...discovered, ...prev.slice(index + 1)];
      });

      const skipped = docs.length - discovered.length;

      if (discovered.length === 0) {
        showToast('Those documents are already in the queue.', 'info');
      } else if (discovered.length > 1 || skipped > 0) {
        // Say what happened to the rest, so "4 documents" on a folder of five
        // does not read like a failed download.
        const tail = skipped > 0 ? ` (${skipped} already queued)` : '';
        showToast(
          `Found ${discovered.length} document${discovered.length === 1 ? '' : 's'} in ${hostOf(item.source)}${tail}.`,
          'success'
        );
      }

      if (result.warnings?.length) {
        // Show the actual reason (e.g. "opened a web page instead of a file")
        // rather than an opaque count — that is what makes the row actionable.
        const [first] = result.warnings;
        const more = result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : '';
        const text = first.length > 160 ? `${first.slice(0, 157)}…` : first;
        showToast(`${text}${more}`, 'info');
      }

      return discovered;
    } catch (err) {
      updateItem(item.id, {
        status: 'error',
        progress: 0,
        errorMessage: `Could not open that link: ${cleanIpcError(err)}`,
      });
      return [];
    } finally {
      window.clearInterval(crawl);
      setResolvingCount((n) => Math.max(0, n - 1));
    }
  }, [onQueueChange, showToast, updateItem]);

  const handleAddUrls = async () => {
    const lines = Array.from(
      new Set(urls.split('\n').map((l) => l.trim()).filter(Boolean))
    );
    if (!lines.length) return;

    const invalid = lines.filter((l) => !isUrl(l));
    if (invalid.length) {
      showToast('Links must start with http:// or https://', 'error');
      return;
    }

    setUrls('');

    const placeholders: QueueItem[] = lines.map((url) => ({
      id: newId(),
      name: url,
      source: url,
      status: 'parsing',
      progress: 5,
    }));
    addItems(placeholders);

    // Resolve a few links at a time so one slow host can't block the rest.
    const results: QueueItem[][] = new Array(placeholders.length).fill([]);
    let cursor = 0;

    const worker = async () => {
      while (cursor < placeholders.length) {
        const i = cursor++;
        results[i] = await resolveLinkItem(placeholders[i]);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(3, placeholders.length) }, () => worker())
    );

    const total = results.reduce((sum, docs) => sum + docs.length, 0);
    if (total === 0) {
      showToast('No documents could be downloaded from those links.', 'error');
    }
  };

  // ── Pipeline ──────────────────────────────────────────────────────────────

  const queued = queue.filter((item) => item.status === 'queued');
  const canRun = queued.length > 0 && !isRunning && resolvingCount === 0;

  const handleRetry = (item: QueueItem) => {
    if (isUrl(item.source) && !item.resolvedPath) {
      void resolveLinkItem(item);
    } else {
      updateItem(item.id, { status: 'queued', progress: 0, errorMessage: undefined });
    }
  };

  const handleRun = async () => {
    if (!canRun) return;
    setIsRunning(true);
    cancelledRef.current = false;
    runItemIdsRef.current = [];

    /** Mark every item that took part in this run as failed, so nothing is left misleading. */
    const failRun = (message: string) => {
      const ids = new Set(runItemIdsRef.current);
      onQueueChange((prev) =>
        prev.map((item) => {
          if (!ids.has(item.id) || item.status === 'done') return item;
          return cancelledRef.current
            ? { ...item, status: 'cancelled', progress: 0, errorMessage: 'Cancelled.' }
            : { ...item, status: 'error', progress: 0, errorMessage: message };
        })
      );
    };

    try {
      // ── 1. Make sure every queued item maps to a real local file ──────────
      const jobs: Array<{ itemId: string; path: string; name: string }> = [];

      for (const item of queueRef.current) {
        if (item.status !== 'queued') continue;

        if (item.resolvedPath) {
          jobs.push({ itemId: item.id, path: item.resolvedPath, name: item.name });
        } else if (isUrl(item.source)) {
          // Not downloaded yet (e.g. added while offline) — try now.
          const discovered = await resolveLinkItem(item);
          for (const doc of discovered) {
            if (doc.resolvedPath) {
              jobs.push({ itemId: doc.id, path: doc.resolvedPath, name: doc.name });
            }
          }
        } else {
          jobs.push({ itemId: item.id, path: item.source, name: item.name });
        }
      }

      if (jobs.length === 0) {
        showToast('Nothing to process — every link failed to download.', 'error');
        return;
      }

      // Remember which rows belong to this run so a failure can be reported on them.
      runItemIdsRef.current = jobs.map((job) => job.itemId);

      // ── 2. Run the worker and map progress by index → queue item ──────────
      const itemIdByIndex = jobs.map((job) => job.itemId);

      const unsubscribe = window.electronAPI.onPipelineProgress((msg: ProgressEvent) => {
        if (msg.type === 'progress') {
          const id = itemIdByIndex[msg.index];
          if (!id) return;
          updateItem(id, {
            status: msg.stage === 'done' ? 'done' : msg.stage,
            progress: msg.stage === 'parsing' ? 40 : msg.stage === 'summarizing' ? 75 : 100,
          });
        } else if (msg.type === 'error') {
          const id = itemIdByIndex[msg.index];
          if (id) {
            updateItem(id, { status: 'error', errorMessage: msg.message, progress: 0 });
          }
        }
      });

      try {
        const slides = await window.electronAPI.runPipeline(
          jobs.map((job) => ({ path: job.path, name: job.name }))
        );
        onSlidesReady(slides);
      } finally {
        unsubscribe();
      }
    } catch (err) {
      const reason = cleanIpcError(err);
      if (cancelledRef.current) {
        showToast('Processing cancelled.', 'info');
      } else {
        showToast(`Processing failed: ${reason}`, 'error');
      }
      // Critical: never leave rows stuck on "Parsing…" after a failure.
      failRun(
        cancelledRef.current
          ? 'Cancelled.'
          : `Could not process this document: ${reason}`
      );
    } finally {
      setIsRunning(false);
    }
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    void window.electronAPI.cancelPipeline();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>
      {/* The whole window accepts a drop, so say so while a file is over it. */}
      {isDragOver && (
        <div className={styles.windowOverlay} aria-hidden="true">
          <span>⬇️ Release to add documents</span>
        </div>
      )}
      {/* Three input columns */}
      <section className={styles.inputRow} aria-label="Document input methods">

        {/* Column 1: Browse */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>📁 Browse Files</h2>
          <p className={styles.cardDesc}>
            Pick individual files or an entire folder.
          </p>
          <div className={styles.btnGroup}>
            <button className={styles.btnPrimary} onClick={handleBrowseFiles}>
              Select Files
            </button>
            <button className={styles.btnSecondary} onClick={handleBrowseDirectory}>
              Open Folder
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.pptx,.txt,.md,.html,.htm"
            style={{ display: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Column 2: Drag & Drop */}
        <div
          className={[styles.card, styles.dropZone, isDragOver ? styles.dropActive : ''].join(' ')}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleBrowseFiles}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void handleBrowseFiles();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Drag and drop documents here, or click to select files"
          aria-dropeffect="copy"
        >
          <span className={styles.dropIcon}>⬇️</span>
          <h2 className={styles.cardTitle}>Drop Documents Here</h2>
          <p className={styles.cardDesc}>
            {isDragOver
              ? 'Release to add files…'
              : 'Drag PDF, DOCX, PPTX, TXT, MD, or HTML files — or a whole folder — anywhere in this window. You can also click here to select files.'}
          </p>
          {dropsBlocked && (
            <p className={styles.offlineNote} role="note">
              Windows blocks drag &amp; drop into apps running as administrator.
              Use Select Files, or restart the app normally to drop files.
            </p>
          )}
          {isDragOver && <div className={styles.dropOverlay} aria-hidden="true" />}
        </div>

        {/* Column 3: Paste URLs */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>🔗 Paste Links</h2>
          <p className={styles.cardDesc}>
            One URL per line. Each link may point to a single document or a
            listing page containing multiple files.
          </p>
          <textarea
            className={styles.urlInput}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder={'https://example.com/report.pdf\nhttps://example.com/data.docx'}
            rows={5}
            aria-label="Paste document URLs, one per line"
          />
          <button
            className={styles.btnPrimary}
            onClick={handleAddUrls}
            disabled={!urls.trim() || resolvingCount > 0}
          >
            {resolvingCount > 0 ? 'Resolving links…' : 'Add to Queue'}
          </button>
          {!navigator.onLine && (
            <p className={styles.offlineNote} role="status">
              ⚠️ You&apos;re offline — links will be retried when you reconnect.
            </p>
          )}
        </div>
      </section>

      {/* Queue */}
      <section className={styles.queueSection} aria-label="Document queue">
        <div className={styles.queueHeader}>
          <h2 className={styles.queueTitle}>
            Queue{queue.length > 0 ? ` (${queue.length})` : ''}
          </h2>
          {queue.length > 0 && (
            <button
              className={styles.btnDanger}
              onClick={() => onQueueChange([])}
              aria-label="Clear all items from queue"
            >
              Clear All
            </button>
          )}
        </div>

        {queue.length === 0 ? (
          <div className={styles.emptyState} role="status">
            <span className={styles.emptyIcon}>📂</span>
            <p>No documents added yet.</p>
            <p className={styles.emptyHint}>Use any of the three methods above to add files.</p>
          </div>
        ) : (
          <ul className={styles.queueList} aria-label="Queued documents">
            {queue.map((item) => (
              <li key={item.id} className={styles.queueItem}>
                <span className={styles.fileName} title={item.resolvedPath ?? item.source}>
                  {item.name}
                </span>
                <span className={styles.fileSize}>
                  {item.size ? formatSize(item.size) : ''}
                </span>
                <span
                  className={[
                    styles.statusBadge,
                    styles[`status_${item.status}`],
                  ].join(' ')}
                  role="status"
                  aria-label={`Status: ${STATUS_LABEL[item.status]}`}
                >
                  {STATUS_LABEL[item.status]}
                </span>

                {/* Progress bar */}
                {item.status !== 'queued' && item.status !== 'done' && item.status !== 'error' && (
                  <div
                    className={styles.progressBar}
                    role="progressbar"
                    aria-valuenow={item.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className={styles.progressFill}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                )}

                {/* Error message */}
                {item.status === 'error' && item.errorMessage && (
                  <p className={styles.errorMsg} role="alert">
                    {item.errorMessage}
                  </p>
                )}

                {/* Actions */}
                <div className={styles.itemActions}>
                  {item.status === 'error' && (
                    <button
                      className={styles.btnIconSmall}
                      onClick={() => handleRetry(item)}
                      aria-label={`Retry ${item.name}`}
                      title="Retry"
                    >
                      🔄
                    </button>
                  )}
                  <button
                    className={styles.btnIconSmall}
                    onClick={() => removeItem(item.id)}
                    aria-label={`Remove ${item.name} from queue`}
                    title="Remove"
                    disabled={isRunning && item.status === 'parsing'}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Run button */}
      <div className={styles.runRow}>
        <button
          className={styles.btnRun}
          onClick={handleRun}
          disabled={!canRun}
          aria-label="Process documents and generate slide deck"
        >
          {isRunning
            ? '⏳ Processing…'
            : `✨ Generate Slides (${queued.length} file${queued.length !== 1 ? 's' : ''})`}
        </button>

        {isRunning && (
          <button
            className={styles.btnCancel}
            onClick={handleCancel}
            aria-label="Cancel processing"
          >
            ✕ Cancel
          </button>
        )}
      </div>
    </div>
  );
}
