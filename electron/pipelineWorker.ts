/**
 * electron/pipelineWorker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs in a Worker thread — never touches the UI thread.
 * Pipeline stages:
 *   1. Parse each file → plain text chunks
 *   2. Summarize each document (extractive TF-IDF / TextRank)
 *   3. Merge all summaries into one unified narrative outline
 *   4. Generate slide objects from the outline
 *
 * Optional LLM upgrade via Ollama (auto-detected, silently skipped if absent).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { workerData, parentPort } from 'worker_threads';
import { parseFile } from './parsers/index';
import { summarize } from './summarizer/index';
import { outlineGroups } from './summarizer/merge';
import { generateSlides } from './slides/generator';
import { guessDocumentTitle } from './text/clean';
import type { PipelineFile, ProgressEvent, Slide } from '../src/types';

function emit(msg: ProgressEvent): void {
  parentPort?.postMessage(msg);
}

/** Reject if a stage takes longer than `ms` (keeps one bad file from blocking the batch). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds`)),
      ms
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

const PARSE_TIMEOUT_MS = 60_000;
const SUMMARIZE_TIMEOUT_MS = 90_000;

async function run(): Promise<void> {
  const raw = (workerData?.files ?? []) as Array<PipelineFile | string>;
  const files: PipelineFile[] = raw.map((entry) =>
    typeof entry === 'string'
      ? { path: entry, name: entry.split(/[\\/]/).pop() ?? entry }
      : entry
  );

  emit({ type: 'start', total: files.length });

  const summaries: string[] = [];
  const docTitles: string[] = [];

  // ── Stage 1 & 2: Parse + Summarize each file ─────────────────────────────
  for (let i = 0; i < files.length; i++) {
    const fp = files[i].path;
    const name = files[i].name || fp.split(/[\\/]/).pop() || fp;

    emit({ type: 'progress', index: i, file: name, stage: 'parsing' });
    let text: string;
    try {
      text = await withTimeout(parseFile(fp), PARSE_TIMEOUT_MS, 'Reading the document');
    } catch (err) {
      emit({
        type: 'error',
        index: i,
        file: name,
        message: humanReadableError(name, err as Error),
      });
      continue;
    }

    // A file that parsed but contains no usable text (scanned PDF, empty page,
    // image-only HTML) must fail loudly instead of producing an empty deck.
    if (text.replace(/[^A-Za-z\u00C0-\u024F0-9]/g, '').length < 40) {
      emit({
        type: 'error',
        index: i,
        file: name,
        message: `"${name}" has no readable text — it may be a scanned image or an empty file.`,
      });
      continue;
    }

    // Best-effort document title, used for the cover slide. Falls back to the
    // file name when the text has no recognisable title line.
    const guessed = guessDocumentTitle(text);
    const fallbackName = name
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    docTitles.push(looksLikeRealTitle(guessed) ? guessed : fallbackName || name);

    emit({ type: 'progress', index: i, file: name, stage: 'summarizing' });
    let summary: string;
    try {
      summary = await withTimeout(summarize(text), SUMMARIZE_TIMEOUT_MS, 'Summarizing the document');
    } catch (err) {
      emit({
        type: 'error',
        index: i,
        file: name,
        message: `"${name}" could not be summarized: ${(err as Error).message}`,
      });
      continue;
    }
    if (!summary.trim()) {
      emit({
        type: 'error',
        index: i,
        file: name,
        message: `"${name}" did not contain any text that could be summarized.`,
      });
      continue;
    }
    summaries.push(summary);

    emit({ type: 'progress', index: i, file: name, stage: 'done' });
  }

  if (summaries.length === 0) {
    emit({ type: 'done', slides: [] });
    return;
  }

  // ── Stage 3: Merge all summaries → one outline per document ───────────────
  // Kept per document so the generator can build each slide from a single
  // source instead of mixing topics from different files on one slide.
  emit({ type: 'merging' });
  const outline = outlineGroups(summaries);

  // ── Stage 4: Generate slides ───────────────────────────────────────────────
  emit({ type: 'generating' });
  const slides: Slide[] = generateSlides(outline, docTitles);

  emit({ type: 'done', slides });
}

/**
 * A guessed title is only useful if it reads like a title. Slide decks and
 * mangled PDFs often produce a run-on line of every text fragment on page 1.
 */
function looksLikeRealTitle(title: string): boolean {
  if (!title || title === 'Presentation') return false;
  if (title.length > 90) return false;
  if (title.startsWith('(')) return false;
  if (title.split(/\s+/).length > 14) return false;
  if (/\b[a-z0-9-]+\.(ac|co|com|org|net|edu|gov|id|io|ai|dev)\b/i.test(title)) return false;
  if (/\d{4,}/.test(title)) return false;
  // Formulas and equation labels are not document titles.
  if (/[=<>≤≥±→]/.test(title)) return false;
  if (/\([a-z]\s*\d/i.test(title)) return false;
  return true;
}

/** Convert common parse errors into human-readable strings. */
function humanReadableError(name: string, err: Error): string {
  const msg = err.message ?? '';
  if (msg.includes('password') || msg.includes('encrypted'))
    return `"${name}" is password-protected and cannot be opened.`;
  if (msg.includes('ENOENT'))
    return `"${name}" was not found — it may have been moved or deleted.`;
  if (msg.includes('EACCES'))
    return `"${name}" cannot be read — permission denied.`;
  if (msg.includes('Unsupported file type'))
    return `"${name}" is not a supported document type.`;
  if (msg.includes('timed out'))
    return `"${name}" took too long to read — the file may be damaged or unusually large.`;
  return `"${name}" could not be parsed: ${msg}`;
}

run().catch((err) => {
  emit({ type: 'fatalError', message: String(err) });
  process.exit(1);
});
