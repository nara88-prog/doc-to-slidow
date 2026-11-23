/**
 * electron/summarizer/merge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Merge multiple per-document summaries into one unified narrative outline.
 *
 * Strategy:
 *   1. Split each summary into sentences.
 *   2. Drop anything that is not slide-worthy (citations, boilerplate).
 *   3. Deduplicate near-identical sentences (Jaccard similarity on content words).
 *   4. Order: intro-flavoured → body → conclusion-flavoured.
 *   5. Cap the total so the deck stays readable, sampling evenly across the
 *      whole outline rather than truncating the tail.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { splitSentences } from '../text/sentences';
import {
  countWords,
  ensureTerminal,
  isBoilerplate,
  isUsableSentence,
  looksLikeCitation,
} from '../text/quality';

/**
 * How many sentences the merged outline keeps.
 *
 * A fixed cap made the deck size independent of the input: five documents
 * contributed 53 summary sentences, 18 were kept, and the result was one
 * content slide per document — a "summary of 5 documents" that showed almost
 * none of them. The budget therefore scales with the number of documents.
 */
const SENTENCES_PER_DOC = 6;
/** A single document still gets a full deck. */
const MIN_SENTENCES = 18;
/** Ceiling, so twenty files do not become a fifty-slide deck. */
const MAX_SENTENCES_ABSOLUTE = 54;

function sentenceBudget(docCount: number): number {
  return Math.min(
    MAX_SENTENCES_ABSOLUTE,
    Math.max(MIN_SENTENCES, docCount * SENTENCES_PER_DOC)
  );
}

/** Words that signal an intro/overview sentence. */
const INTRO_SIGNALS = [
  'introduc', 'overview', 'background', 'purpose', 'aim', 'goal', 'objectiv',
  'abstract', 'this study', 'this paper', 'this research', 'this article',
];
/** Words that signal a conclusion/summary sentence. */
const CONCLUSION_SIGNALS = [
  'conclud', 'summary', 'recommend', 'future work', 'next step', 'in summary',
  'overall', 'taken together', 'in short', 'to sum up',
];

function sentenceSignal(s: string): 'intro' | 'conclusion' | 'body' {
  const lower = s.toLowerCase();
  if (CONCLUSION_SIGNALS.some((w) => lower.includes(w))) return 'conclusion';
  if (INTRO_SIGNALS.some((w) => lower.includes(w))) return 'intro';
  return 'body';
}

/** Content words only — used for similarity, not for display. */
function contentWords(sentence: string): Set<string> {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had',
    'are', 'was', 'were', 'been', 'being', 'not', 'but', 'can', 'will', 'would',
    'could', 'should', 'may', 'might', 'their', 'there', 'these', 'those', 'they',
    'them', 'then', 'than', 'into', 'over', 'under', 'about', 'which', 'while',
    'where', 'when', 'what', 'who', 'how', 'also', 'such', 'more', 'most', 'some',
    'other', 'only', 'just', 'very', 'each', 'both', 'between', 'within',
  ]);
  return new Set(
    sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s\u00C0-\u024F]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stop.has(w) && !/^\d+$/.test(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach((t) => {
    if (b.has(t)) shared++;
  });
  return shared / (a.size + b.size - shared);
}

/** Keep `max` items spread evenly across the list (always keeps first + last). */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return out;
}

/** Sentences from one summary that survive filtering, in document order. */
function usableSentences(summary: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of splitSentences(summary)) {
    const s = raw.trim();
    if (!s || countWords(s) < 5) continue;
    if (isBoilerplate(s) || looksLikeCitation(s) || !isUsableSentence(s)) continue;

    // Exact-duplicate guard (cheap, catches repeated headers across docs).
    const key = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(s);
  }
  return out;
}

/** Drop near-duplicates, keeping the first occurrence. */
function dedupeNear(sentences: string[]): string[] {
  const vectors = sentences.map(contentWords);
  const kept: number[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const duplicate = kept.some((j) => jaccard(vectors[i], vectors[j]) > 0.72);
    if (!duplicate) kept.push(i);
  }
  return kept.map((i) => sentences[i]);
}

/** Intro-flavoured first, then body, then conclusion-flavoured. */
function orderSentences(sentences: string[]): string[] {
  const intros = sentences.filter((s) => sentenceSignal(s) === 'intro');
  const body = sentences.filter((s) => sentenceSignal(s) === 'body');
  const conclusions = sentences.filter((s) => sentenceSignal(s) === 'conclusion');
  return [...intros, ...body, ...conclusions];
}

/**
 * Split a sentence budget across documents in proportion to what each one has.
 *
 * A flat budget spread over the whole outline mixed documents together, so a
 * slide about one document's topic carried a sentence from another ("Back
 * Propagation" followed by a physics finding). Grouping keeps every slide
 * about one source, and a proportional split keeps a long document from being
 * represented by three sentences while a short one gets six.
 */
function shareBudget(available: number[], budget: number): number[] {
  const total = available.reduce((a, b) => a + b, 0);
  if (total <= budget) return available;

  const shares = available.map((n) => Math.max(1, Math.round((n / total) * budget)));
  // Rounding can overshoot; trim from the largest shares until it fits.
  let sum = shares.reduce((a, b) => a + b, 0);
  while (sum > budget) {
    let largest = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i] > shares[largest]) largest = i;
    if (shares[largest] <= 1) break;
    shares[largest]--;
    sum--;
  }
  return shares;
}

/**
 * Merge per-document summaries into one group of sentences per document.
 *
 * The deck generator keeps each group together, so every slide belongs to a
 * single source document. Groups are already ordered and deduplicated.
 */
export function outlineGroups(summaries: string[]): string[][] {
  const seen = new Set<string>();

  const groups = summaries
    .map((summary) => dedupeNear(usableSentences(summary, seen)))
    .map(orderSentences)
    .filter((g) => g.length > 0);

  if (groups.length === 0) return [];

  const caps = shareBudget(
    groups.map((g) => g.length),
    sentenceBudget(summaries.length)
  );

  return groups.map((group, i) => sampleEvenly(group, caps[i]).map(ensureTerminal));
}

/**
 * Merge an array of per-document summary strings into a single ordered outline.
 */
export function mergeOutlines(summaries: string[]): string {
  const groups = outlineGroups(summaries);

  if (groups.length === 0) {
    // Everything was filtered — fall back to the raw summaries so the user
    // still gets a deck rather than a dead end.
    return summaries.join(' ').replace(/\s+/g, ' ').trim();
  }

  return groups.flat().join(' ');
}
