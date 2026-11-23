/**
 * electron/summarizer/extractive.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-JS extractive summarizer. No external dependencies — works fully offline.
 *
 * Algorithm:
 *   1. Clean the text and drop the bibliography section.
 *   2. Split into sentences (abbreviation-aware) and discard sentences that
 *      cannot make a useful slide: licence text, journal headers, citations,
 *      author lists, table rows.
 *   3. Score the rest with TF-IDF, weighted by position, length and cue
 *      phrases ("the purpose of this study", "results show", "in conclusion").
 *   4. Pick the best sentences with a diversity check (MMR) so the summary is
 *      not five rephrasings of the same point.
 *   5. Return them in original document order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normalizeWhitespace } from '../text/clean';
import { splitSentences } from '../text/sentences';
import {
  countWords,
  ensureTerminal,
  isBoilerplate,
  isUsableSentence,
  looksLikeCitation,
  stripReferenceSection,
} from '../text/quality';

/** Common words that carry no topical meaning. */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an',
  'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'doing', 'down', 'during', 'each', 'either', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'may', 'me', 'might', 'more', 'most', 'must', 'my', 'myself', 'no',
  'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shall', 'she', 'should',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your', 'yours', 'yourself', 'yourselves', 'thus', 'hence',
  'therefore', 'however', 'moreover', 'furthermore', 'although', 'though',
  'within', 'without', 'upon', 'among', 'across', 'per', 'via', 'etc',
]);

/** Phrases that usually introduce a thesis, finding, or conclusion. */
const CUE_BONUS: [RegExp, number][] = [
  [/^(this|the)\s+(study|research|paper|article|work|report|review)\b/i, 0.14],
  [/\b(we|this study|the authors?)\s+(propose|present|show|found|argue|demonstrate|report|conclude|examine)/i, 0.16],
  [/\b(results?|findings?|data|analysis)\b[^.]{0,40}\b(show|shows|showed|indicate|indicates|indicated|suggest|suggests|suggested|reveal|reveals|revealed|demonstrate|demonstrates)/i, 0.14],
  [/\b(in conclusion|in summary|overall|taken together|this means|the main)\b/i, 0.16],
  [/\b(purpose|aim|objective|goal)\b[^.]{0,30}\b(of|was|is)\b/i, 0.12],
  [/\b(important|significant|key|main|primary|critical|essential|fundamental)\b/i, 0.06],
  [/\b(because|therefore|consequently|as a result|leads? to|results? in)\b/i, 0.05],
  [/\b(is defined as|refers? to|is called|means that|consists? of)\b/i, 0.08],
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\u00C0-\u024F]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  a.forEach((t) => {
    if (b.has(t)) shared++;
  });
  return shared / (a.size + b.size - shared);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Summarize a document.
 * @param text Raw document text (any whitespace state).
 * @param targetSentences Optional cap; chosen adaptively when omitted.
 */
export function extractiveSummarize(text: string, targetSentences?: number): string {
  const cleaned = stripReferenceSection(normalizeWhitespace(text));
  const all = splitSentences(cleaned)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Preferred pool: real prose, no boilerplate, no citations.
  let sentences = all.filter(
    (s) => isUsableSentence(s) && !isBoilerplate(s) && !looksLikeCitation(s)
  );

  // Relax the citation filter before giving up: some documents are dense with
  // names and years in legitimate prose.
  if (sentences.length < 3) {
    sentences = all.filter((s) => isUsableSentence(s) && !isBoilerplate(s));
  }

  // Last resort: anything with a few words, so a short document still works.
  if (sentences.length === 0) {
    sentences = all.filter((s) => countWords(s) >= 4);
  }

  if (sentences.length === 0) return '';
  if (sentences.length <= 4) return sentences.map(ensureTerminal).join(' ');

  // Very long documents (books, manuals) have no single thesis. Skip the front
  // matter (title page, copyright, dedication, credits, table of contents) and
  // then build a pool from the opening material plus an even spread through the
  // rest of the document.
  if (sentences.length > 300) {
    sentences = sentences.slice(Math.min(60, Math.floor(sentences.length * 0.03)));
  }
  if (sentences.length > 160) {
    // A book's preface is long: keep only a small slice of it so the deck is
    // built from the whole work rather than the first few pages.
    const headCount = sentences.length > 300 ? 15 : 60;
    const head = sentences.slice(0, headCount);
    const tail = sentences.slice(-10);
    const middleAll = sentences.slice(headCount, -10);
    const step = Math.max(1, Math.floor(middleAll.length / 90));
    const middle = middleAll.filter((_, i) => i % step === 0).slice(0, 90);
    sentences = [...head, ...middle, ...tail];
  }

  const target = clamp(
    targetSentences ?? Math.round(sentences.length * 0.16),
    5,
    14
  );

  const N = sentences.length;
  const tokenSets = sentences.map((s) => new Set(tokenize(s)));

  // Document frequency per term.
  const df = new Map<string, number>();
  tokenSets.forEach((set) => {
    set.forEach((term) => df.set(term, (df.get(term) ?? 0) + 1));
  });

  const scored = sentences.map((sentence, i) => {
    const tokens = tokenize(sentence);
    if (tokens.length === 0) return { i, score: 0 };

    const tf = new Map<string, number>();
    tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));

    let score = 0;
    tf.forEach((freq, term) => {
      const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1));
      score += (1 + Math.log(freq)) * idf;
    });

    // Normalise by length so a single long sentence cannot dominate the deck.
    score /= Math.sqrt(tokens.length);

    // Earlier sentences carry the thesis/abstract; later ones are often
    // references or appendices.
    const position = i / Math.max(1, N - 1);
    score *= 1.18 - 0.28 * position;

    // Prefer sentences in the readable slide-bullet range.
    const words = countWords(sentence);
    if (words < 8) score *= 0.78;
    else if (words > 36) score *= 0.8;

    // Cue phrases.
    for (const [pattern, bonus] of CUE_BONUS) {
      if (pattern.test(sentence)) score *= 1 + bonus;
    }

    // Digit-heavy sentences are usually tables or formulas.
    const digits = (sentence.match(/\d/g) ?? []).length;
    if (digits / sentence.length > 0.1) score *= 0.72;

    return { i, score };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const chosen: number[] = [];

  // Greedy MMR: high score, low overlap with what is already chosen.
  for (const { i, score } of ranked) {
    if (chosen.length >= target) break;
    if (score <= 0) continue;
    const tooSimilar = chosen.some((j) => jaccard(tokenSets[i], tokenSets[j]) > 0.6);
    if (!tooSimilar) chosen.push(i);
  }

  // If the diversity rule was too strict, top up by score.
  if (chosen.length < Math.min(target, sentences.length)) {
    for (const { i } of ranked) {
      if (chosen.length >= target) break;
      if (!chosen.includes(i)) chosen.push(i);
    }
  }

  chosen.sort((a, b) => a - b);
  return chosen.map((i) => ensureTerminal(sentences[i])).join(' ');
}
