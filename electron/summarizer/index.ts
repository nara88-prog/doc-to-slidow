/**
 * electron/summarizer/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Public entry point for summarization.
 * Strategy:
 *   1. Try local LLM via Ollama (if running on localhost:11434) — silently skip.
 *   2. Fall back to built-in extractive TF-IDF / TextRank summarizer.
 *
 * The fallback is ALWAYS available. The LLM path is an enhancement only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { extractiveSummarize } from './extractive';
import { ollamaSummarize, isOllamaAvailable } from './ollama';

export async function summarize(text: string): Promise<string> {
  // ── LLM upgrade path ────────────────────────────────────────────────────────
  // Check Ollama availability once per call. If unavailable, fall through.
  if (await isOllamaAvailable()) {
    try {
      const result = (await ollamaSummarize(text))
        // Some models answer with markdown bullets; flatten them.
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (result.length >= 80) return result;
    } catch {
      // Silently fall through to built-in summarizer
    }
  }

  // ── Built-in extractive summarizer (always works) ──────────────────────────
  return extractiveSummarize(text);
}
