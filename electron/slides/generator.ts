/**
 * electron/slides/generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Convert a merged narrative outline into an array of Slide objects.
 *
 * Quality rules:
 *   - A slide title is a real noun phrase from a real sentence, not the first
 *     seven words chopped off ("A Wahyudi M Kafrawi M" is not a title).
 *   - Bullets are complete clauses, capitalised, without trailing periods, and
 *     never truncated mid-phrase.
 *   - The same bullet never appears twice in the deck.
 *   - The closing slide is reserved from the outline tail, so "Key Takeaways"
 *     says something new instead of repeating the last content slide.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Slide } from '../../src/types';
import { toSingleLine } from '../text/clean';
import { splitClauses, splitSentences } from '../text/sentences';
import {
  countWords,
  isBoilerplate,
  isUsableSentence,
  looksLikeCitation,
} from '../text/quality';

// ── Icons ────────────────────────────────────────────────────────────────────

const ICON_HINTS: [RegExp, string][] = [
  [/data|statistic|metric|number|percent|survey|result/i, '📊'],
  [/goal|aim|objective|target|plan|purpose/i, '🎯'],
  [/team|people|staff|employee|user|student|participant|subject/i, '👥'],
  [/money|cost|budget|revenue|finance|profit|price|econom/i, '💰'],
  [/tech|software|system|platform|code|api|digital|computer|algorithm/i, '💻'],
  [/grow|increase|expand|scale|rise|improve|develop/i, '📈'],
  [/risk|challenge|problem|issue|threat|barrier|limitation|weakness/i, '⚠️'],
  [/solution|answer|fix|resolve|approach|strategy|method/i, '✅'],
  [/time|schedule|deadline|timeline|phase|process|step/i, '🗓️'],
  [/innovat|new|future|next|transform|change|trend/i, '🚀'],
  [/learn|teach|educat|course|school|class|study|research/i, '🎓'],
  [/health|medical|patient|disease|clinic|therapy/i, '🩺'],
  [/law|legal|policy|regulation|government|right/i, '⚖️'],
  [/environment|climate|energy|sustainab|green|nature/i, '🌱'],
  [/communicat|language|write|read|speak|media/i, '💬'],
];

function suggestIcon(text: string): string {
  for (const [pattern, icon] of ICON_HINTS) {
    if (pattern.test(text)) return icon;
  }
  return '📌';
}

// ── Phrasing helpers ─────────────────────────────────────────────────────────

/** Discourse markers that add nothing to a slide title. */
const LEADING_NOISE =
  /^(abstract|abstrak|intisari|ringkasan)\s*[:：]\s*|^(however|moreover|furthermore|therefore|thus|hence|in addition|additionally|also|but|and|so|as a result|for example|for instance|in contrast|on the other hand|meanwhile|first|firstly|second|secondly|third|thirdly|finally|next|then|indeed|notably|specifically|in particular|generally|typically|usually|often|sometimes|recently|currently)\b[,:]?\s*/i;

/** Sentence patterns that bury the actual topic behind a formulaic opening. */
const TITLE_REWRITES: [RegExp, string][] = [
  [/^in this (study|paper|research|article|work|report|review)[,:]?\s+/i, ''],
  [/^this (study|paper|research|article|work|report|review) (aims?|seeks?|attempts?|tries?) to\s+/i, ''],
  [
    /^the (purpose|aim|objective|goal|focus) of (this|the) (study|research|paper|article|work|report|review) (was|is|will be)?\s*(to\s+)?/i,
    '',
  ],
  [
    /^this (study|paper|research|article|work|report|review) (examines?|explores?|investigates?|analyses?|analyzes?|discusses?|presents?|describes?|reports?|focuses? on|deals? with)\s+/i,
    '',
  ],
  [
    /^(the )?(results?|findings?|data|analysis)( of (this|the) (study|research|paper))?\s+(show|shows|showed|indicate|indicates|indicated|suggest|suggests|suggested|reveal|reveals|revealed|demonstrate|demonstrates|demonstrated) that\s+/i,
    '',
  ],
  [/^(it|this) (is|was|has been) (found|shown|observed|noted|suggested|argued) that\s+/i, ''],
  [/^according to (the|this) (study|research|paper|article|report)[,:]?\s+/i, ''],
];

/** Words that end a noun phrase: prepositions, conjunctions, auxiliaries, verbs. */
const BOUNDARY_WORDS = new Set([
  // prepositions / conjunctions (English)
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about', 'into',
  'over', 'under', 'between', 'among', 'through', 'during', 'after', 'before',
  'against', 'within', 'without', 'upon', 'per', 'via', 'as', 'than', 'that',
  'which', 'who', 'whom', 'whose', 'where', 'when', 'while', 'whereas',
  'because', 'if', 'although', 'though', 'since', 'unless', 'until', 'and',
  'or', 'but', 'nor', 'yet',
  // prepositions / conjunctions (Indonesian — common in source documents)
  'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'dalam', 'pada', 'untuk', 'dengan',
  'tentang', 'sebagai', 'oleh', 'terhadap', 'antara', 'karena', 'sehingga',
  'agar', 'jika', 'ketika', 'saat', 'setelah', 'sebelum', 'selama', 'melalui',
  'secara', 'terkait', 'mengenai', 'bagi', 'tanpa', 'hingga', 'sampai',
  // auxiliaries / copulas
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must', 'adalah', 'ialah', 'merupakan', 'menjadi', 'telah',
  'dapat', 'bisa', 'akan',
  // common finite verbs that signal the end of a subject phrase
  'show', 'shows', 'showed', 'shown', 'indicate', 'indicates', 'indicated',
  'suggest', 'suggests', 'suggested', 'reveal', 'reveals', 'revealed', 'found',
  'find', 'finds', 'report', 'reports', 'reported', 'examine', 'examines',
  'examined', 'explore', 'explores', 'explored', 'investigate', 'investigates',
  'investigated', 'analyze', 'analyzes', 'analyse', 'analyses', 'analyzed',
  'analysed', 'discuss', 'discusses', 'discussed', 'present', 'presents',
  'presented', 'describe', 'describes', 'described', 'focus', 'focuses',
  'focused', 'aim', 'aims', 'aimed', 'seek', 'seeks', 'sought', 'attempt',
  'attempts', 'attempted', 'use', 'uses', 'used', 'using', 'include',
  'includes', 'included', 'including', 'consist', 'consists', 'consisted',
  'contain', 'contains', 'contained', 'provide', 'provides', 'provided',
  'require', 'requires', 'required', 'allow', 'allows', 'allowed', 'help',
  'helps', 'helped', 'make', 'makes', 'made', 'give', 'gives', 'gave', 'take',
  'takes', 'took', 'become', 'becomes', 'became', 'seem', 'seems', 'seemed',
  'appear', 'appears', 'appeared', 'mean', 'means', 'meant', 'refer', 'refers',
  'referred', 'involve', 'involves', 'involved', 'relate', 'relates', 'related',
  'affect', 'affects', 'affected', 'improve', 'improves', 'improved',
  'increase', 'increases', 'increased', 'reduce', 'reduces', 'reduced',
  'lead', 'leads', 'led', 'result', 'results', 'resulted', 'based', 'compared',
  // common Indonesian verbs / auxiliaries
  'terjadi', 'dilakukan', 'dilaksanakan', 'memberikan', 'memastikan', 'memiliki',
  'mendapat', 'menggunakan', 'menunjukkan', 'menjelaskan', 'membuat',
  'terdapat', 'terbagi', 'berupa', 'meliputi', 'terdiri', 'berarti', 'disebut',
  'perlu', 'harus', 'kepada', 'bagi', 'terhadap',
]);

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'vs', 'via', 'per', 'nor', 'so', 'yet',
]);

const TRAILING_FILLER = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'and', 'or', 'but',
  'the', 'a', 'an', 'that', 'which', 'who', 'whose', 'as', 'than', 'is', 'are',
  'was', 'were', 'be', 'been', 'has', 'have', 'had', 'its', 'their', 'this',
  'these', 'those',
  // Indonesian connectors that leave a title hanging.
  'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'dalam', 'pada', 'untuk', 'dengan',
  'tentang', 'sebagai', 'oleh', 'terhadap', 'antara', 'karena', 'sehingga',
  'terkait', 'mengenai', 'bagi', 'tanpa', 'adalah', 'ialah', 'merupakan',
  // Indonesian auxiliaries/adverbs — a title must not stop on one of these.
  'bisa', 'dapat', 'akan', 'telah', 'sedang', 'masih', 'sudah', 'juga', 'sangat',
  'lebih', 'hanya', 'perlu', 'harus', 'tidak', 'bukan', 'maka', 'agar', 'supaya',
]);

function capitalizeFirst(value: string): string {
  const match = value.match(/^([^A-Za-z\u00C0-\u024F]*)([\s\S]*)$/);
  if (!match) return value;
  const [, prefix, rest] = match;
  if (!rest) return value;
  return prefix + rest.charAt(0).toUpperCase() + rest.slice(1);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function trimTrailingFiller(words: string[]): string[] {
  const out = [...words];
  while (
    out.length > 4 &&
    TRAILING_FILLER.has(out[out.length - 1].toLowerCase().replace(/[^a-z]/g, ''))
  ) {
    out.pop();
  }
  return out;
}

/** Turn a raw phrase into a clean, title-cased slide title. */
function finalizeTitle(raw: string): string {
  let words = trimUnbalancedParens(raw)
    // Titles never need quotation marks around them (apostrophes stay).
    .replace(/[“”„‟"]/g, '')
    .replace(/[\s.,;:!?–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  if (words.length === 0) return '';
  words = collapseRepeats(trimTrailingFiller(words));

  // Drop a leading article when the title is long enough to survive without it.
  if (words.length > 3 && ['the', 'a', 'an'].includes(words[0].toLowerCase())) {
    words = words.slice(1);
  }

  const cased = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      // Preserve acronyms, internal capitals and proper nouns as written.
      if (/[A-Z]/.test(word.slice(1)) || (word.length > 1 && word === word.toUpperCase())) {
        return word;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');

  // A hard 90-character cap can itself split a bracket, so repair again after
  // slicing ("Mahasiswa Mampu Mengklasifikasikan Algoritma Utama AI (jaringan
  // Saraf").
  const capped = cased.length > 90 ? trimUnbalancedParens(cased.slice(0, 90)) : cased;
  return capped.replace(/[\s.,;:–—-]+$/, '');
}

/**
 * Remove a phrase that is immediately repeated.
 *
 * Headings in source documents are often followed by the sentence that names
 * them again ("Deskripsi Mata Kuliah Mata Kuliah Ini Bertujuan ..."), and the
 * repetition reads as a stutter on a slide.
 */
function collapseRepeats(words: string[]): string[] {
  const key = (w: string): string => w.toLowerCase().replace(/[^a-z\u00C0-\u024F0-9]/g, '');
  const out = [...words];
  let changed = true;
  while (changed) {
    changed = false;
    // Longest run first, so "Mata Kuliah Mata Kuliah" collapses as a unit.
    for (let size = 3; size >= 1 && !changed; size--) {
      for (let i = 0; i + size * 2 <= out.length; i++) {
        const a = out.slice(i, i + size).map(key).join(' ');
        const b = out.slice(i + size, i + size * 2).map(key).join(' ');
        if (a && a === b) {
          out.splice(i + size, size);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Openings that make a title read as a clause fragment instead of a topic. */
const TITLE_BAD_STARTS = new Set([
  // Indonesian subordinators / prepositions
  'ketika', 'saat', 'jika', 'bila', 'apabila', 'setelah', 'sebelum', 'selama',
  'karena', 'sehingga', 'agar', 'supaya', 'untuk', 'dengan', 'dalam', 'pada',
  'di', 'ke', 'dari', 'bagi', 'sebagai', 'menurut', 'berdasarkan', 'bahwa',
  'yang', 'dan', 'atau', 'tetapi', 'tapi', 'namun', 'sedangkan', 'sementara',
  'oleh', 'secara', 'meskipun', 'walaupun', 'seperti', 'hingga', 'sampai',
  // Indonesian auxiliaries/adverbs: a topic never starts with one ("Telah Dijelaskan").
  'telah', 'sudah', 'akan', 'sedang', 'masih', 'juga', 'hanya', 'lebih',
  'sangat', 'dapat', 'bisa', 'harus', 'perlu', 'tidak', 'bukan', 'maka',
  'serta', 'yaitu', 'yakni', 'merupakan', 'adalah', 'ialah', 'terdapat',
  // English equivalents
  'when', 'if', 'because', 'although', 'though', 'since', 'after', 'before',
  'while', 'as', 'to', 'for', 'in', 'on', 'at', 'by', 'from', 'with', 'that',
  'which', 'who', 'and', 'or', 'but', 'so', 'thus', 'hence', 'therefore',
]);

/**
 * Words that leave a title unfinished when they are last: a pronoun has no
 * referent ("... Memungkinkan Kita"), an adverb has nothing to modify.
 */
const TITLE_BAD_ENDS = new Set([
  'kita', 'kami', 'mereka', 'saya', 'anda', 'dia', 'ia', 'kamu', 'ini', 'itu',
  'tersebut', 'sendiri', 'bersama', 'saja', 'pula', 'lagi', 'kembali',
  // A question word cannot end a topic ("Bentuk Paradigma Pemrograman Apakah").
  'apakah', 'apa', 'siapa', 'bagaimana', 'mengapa', 'kenapa', 'kapan', 'mana',
  // Verbs that need an object ("... Mengeksekusi Program, Mulai").
  'mulai', 'dimulai', 'berakhir', 'selesai',
  // Modals that need a verb after them ("Mahasiswa Mampu").
  'mampu', 'boleh', 'ingin', 'hendak', 'perlu', 'harus', 'wajib',
  'can', 'could', 'must', 'should', 'will', 'would', 'may', 'might', 'able',
  'us', 'we', 'they', 'you', 'it', 'them', 'itself', 'themselves', 'too',
  'what', 'how', 'why',
]);

/**
 * Is this string a presentable slide title?
 *
 * A fragment reads as a bug on a slide ("Ketika Pengguna", "Struktur Ini
 * Memungkinkan Kita"), so a candidate that opens with a subordinator or ends on
 * a pronoun is rejected and the caller tries the next sentence.
 */
function isUsableTitle(title: string): boolean {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (countWords(title) < 2) return false;

  const clean = (w: string): string =>
    w.toLowerCase().replace(/[^a-z\u00C0-\u024F'-]/g, '');

  if (TITLE_BAD_STARTS.has(clean(words[0]))) return false;

  const last = clean(words[words.length - 1]);
  // A preposition, auxiliary or finite verb cannot end a topic: it needs an
  // object that the cut removed ("... Tempat Mengeksekusi Program, Mulai").
  if (BOUNDARY_WORDS.has(last)) return false;
  if (DANGLING_ENDINGS.has(last) || TITLE_BAD_ENDS.has(last)) return false;

  return true;
}

/** Derive a slide title from one sentence. Returns '' when it cannot. */
function deriveTitle(sentence: string): string {
  const raw = deriveTitleRaw(sentence);
  return isUsableTitle(raw) ? raw : '';
}

/** Derive a slide title from one sentence, without the quality gate. */
function deriveTitleRaw(sentence: string): string {
  // A list on one line ("Books by X • Title • Title") has no single title.
  let text = toSingleLine(stripAttribution(sentence))
    .split(/\s*[•·▪◦‣●]\s*/)[0]
    // "Fungsional (functional) o Sesuai namanya ..." — drop the next item.
    .split(/\s+o\s+(?=[A-Z\u00C0-\u00DE])/)[0]
    .replace(LEADING_NOISE, '');

  for (const [pattern, replacement] of TITLE_REWRITES) {
    text = text.replace(pattern, replacement);
  }
  text = capitalizeFirst(text.replace(LEADING_NOISE, ''));

  // "Motion and force: a study of ..." → "Motion and Force"
  const colon = text.match(/^([^:]{8,70}):\s+\S/);
  if (colon && countWords(colon[1]) >= 2) {
    return finalizeTitle(colon[1]);
  }

  const words = text.split(/\s+/).filter(Boolean);

  // Cut at the first structural boundary that leaves a usable phrase.
  // A boundary word that is capitalised is usually part of a name or a
  // compound ("Team Based Learning"), so it must not end the title.
  for (let i = 2; i < Math.min(words.length, 12); i++) {
    const source = words[i];
    if (/^[A-Z]/.test(source)) continue;
    const word = source.toLowerCase().replace(/[^a-z'-]/g, '');
    if (!BOUNDARY_WORDS.has(word)) continue;

    // Never end a title on a function word ("Paradigma yang").
    const last = words[i - 1].toLowerCase().replace(/[^a-z]/g, '');
    if (TRAILING_FILLER.has(last)) continue;

    const candidate = words.slice(0, i).join(' ');
    if (candidate.length >= 12 && countWords(candidate) >= 2) {
      return finalizeTitle(candidate);
    }
  }

  return finalizeTitle(words.slice(0, 8).join(' '));
}

/** Fallback title built from the most frequent meaningful words in a chunk. */
function keywordTitle(text: string): string {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had',
    'are', 'was', 'were', 'been', 'being', 'not', 'but', 'can', 'will', 'would',
    'could', 'should', 'may', 'might', 'their', 'there', 'these', 'those', 'they',
    'them', 'then', 'than', 'into', 'over', 'under', 'about', 'which', 'while',
    'where', 'when', 'what', 'who', 'how', 'also', 'such', 'more', 'most', 'some',
    'other', 'only', 'just', 'very', 'each', 'both', 'between', 'within', 'study',
    'research', 'paper', 'article', 'result', 'results', 'using', 'used',
  ]);

  const counts = new Map<string, number>();
  const order: string[] = [];

  for (const raw of text.toLowerCase().split(/[^a-z0-9\u00C0-\u024F]+/)) {
    if (raw.length < 4 || stop.has(raw) || /^\d+$/.test(raw)) continue;
    // A keyword title is the last resort, so it must not be built from words
    // that read as a fragment ("... & Bersama").
    if (DANGLING_ENDINGS.has(raw) || TITLE_BAD_ENDS.has(raw) || TITLE_BAD_STARTS.has(raw)) {
      continue;
    }
    if (!counts.has(raw)) order.push(raw);
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }

  const ranked = order
    .map((word, index) => ({ word, index, count: counts.get(word) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index);

  // "Pemrograman & Program" reads as a typo: the second keyword is a stem of
  // the first. Keep only the strongest keyword when two of them overlap.
  const stem = (w: string): string => w.slice(0, Math.max(4, Math.ceil(w.length * 0.7)));
  const picked: typeof ranked = [];
  for (const entry of ranked) {
    const s = stem(entry.word);
    const overlaps = picked.some((p) => {
      const q = stem(p.word);
      return s.startsWith(q) || q.startsWith(s) || entry.word.includes(p.word) || p.word.includes(entry.word);
    });
    if (overlaps) continue;
    picked.push(entry);
    if (picked.length === 2) break;
  }

  const top = picked
    .sort((a, b) => a.index - b.index)
    .map((x) => finalizeTitle(x.word));

  return top.join(' & ');
}

// ── Bullets ──────────────────────────────────────────────────────────────────

/** Conjunctions that open a new clause — safe places to end a shortened bullet. */
const CUT_CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'nor', 'yet', 'so', 'which', 'that', 'who', 'whom',
  'whose', 'where', 'when', 'while', 'because', 'although', 'though', 'since',
  'if', 'unless', 'until', 'after', 'before', 'dan', 'tetapi', 'tapi', 'atau',
  'yang', 'karena', 'sehingga', 'walaupun', 'meskipun', 'jika', 'ketika', 'saat',
  'setelah', 'sebelum', 'agar', 'supaya', 'namun', 'sedangkan', 'sementara',
]);

/** Prepositions that leave a phrase hanging when they end a clause. */
const CUT_PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about',
  'between', 'during', 'through', 'dari', 'dalam', 'pada', 'untuk', 'dengan',
]);

/** Shorten a clause at a natural boundary instead of cutting mid-phrase. */
function shortenClause(clause: string, maxWords = 26): string {
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return clause;

  const bareWord = (word: string) =>
    word.toLowerCase().replace(/[^a-z\u00C0-\u024F]/g, '');

  // Cut before a conjunction that starts a new clause: everything before it
  // is already a complete phrase ("... and be prepared to ..."). The tail must
  // be long enough to stand on its own, or the cut leaves an orphan like
  // "... parsing both with large | and limited training data".
  for (let i = maxWords - 1; i >= 8; i--) {
    if (!CUT_CONJUNCTIONS.has(bareWord(words[i]))) continue;
    if (words.length - i < 5) continue;
    const candidate = words.slice(0, i).join(' ');
    if (countWords(candidate) < 6) continue;
    if (endsDangling(candidate)) continue;
    return candidate;
  }

  // Then prefer a comma boundary.
  for (let i = maxWords; i >= 8; i--) {
    if (!words[i - 1].endsWith(',')) continue;
    const candidate = words.slice(0, i - 1).join(' ');
    if (countWords(candidate) < 5) continue;
    if (endsDangling(candidate)) continue;
    return candidate;
  }

  // Otherwise cut just before a preposition, leaving a complete phrase.
  for (let i = maxWords - 1; i >= 8; i--) {
    if (!CUT_PREPOSITIONS.has(bareWord(words[i]))) continue;
    const candidate = words.slice(0, i).join(' ');
    if (countWords(candidate) < 6) continue;
    if (endsDangling(candidate)) continue;
    return candidate;
  }

  return trimTrailingFiller(words.slice(0, maxWords)).join(' ');
}

/**
 * Repair parentheses left over from a cut clause.
 *
 * A fragment can open a bracket it never closes ("... AI (jaringan saraf") or
 * close one that was opened in the part that got cut ("... sistem pakar)
 * berdasarkan ..."). Both read as breakage on a slide.
 */
function trimUnbalancedParens(text: string): string {
  let depth = 0;
  let lastOpen = -1;
  let out = '';

  for (const ch of text) {
    if (ch === '(') {
      if (depth === 0) lastOpen = out.length;
      depth++;
      out += ch;
    } else if (ch === ')') {
      if (depth === 0) {
        // A closer with nothing to close — drop it and the space before it.
        out = out.replace(/\s+$/, '');
        continue;
      }
      depth--;
      out += ch;
    } else {
      out += ch;
    }
  }

  return depth > 0 && lastOpen >= 0 ? out.slice(0, lastOpen).trim() : out.trim();
}

function bulletFromClause(clause: string): string {
  let text = clause
    .trim()
    .replace(LEADING_NOISE, '')
    // Drop leftover list markers and bullet glyphs: "a) ...", "• ...".
    .replace(/^\(?[a-h]\)\s+/i, '')
    .replace(/^\(\d{1,2}\)\s+/, '')
    .replace(/^\d{1,2}[.)]\s+/, '')
    .replace(/^[•·▪◦‣●*–—-]\s+/, '')
    .replace(/^o\s+(?=[A-Z\u00C0-\u00DE])/, '')
    .replace(/\s*[•·▪◦‣●]\s*/g, ' ')
    .replace(/^(that|which|who|where|when|while|and|but|so)\s+/i, '')
    .replace(/^[,;:–—-]+\s*/, '')
    // Trailing slide/page numbers ("... duduk di atasnya. 5").
    .replace(/\.\s*\d{1,3}$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Bullets do not end with a period.
  text = text.replace(/[\s,;:.!?–—-]+$/g, '');
  return capitalizeFirst(trimUnbalancedParens(text));
}

/**
 * Remove "According to Smith (2016), ..." / "Menurut Abriani & Nursalam,
 * (2016) ..." openings. The attribution is noise on a slide; the claim is not.
 */
function stripAttribution(sentence: string): string {
  return sentence
    .replace(
      /^(according to|as (?:stated|reported|noted|argued|explained|described) by|based on|per|menurut|berdasarkan)\s+[^,]{2,70},?\s*/i,
      ''
    )
    .replace(/^\(\d{4}[a-z]?\)\s*/, '')
    .replace(
      /^[A-Z][A-Za-z'’\-]+(?:\s*(?:&|and|dan)\s*[A-Z][A-Za-z'’\-]+)?\s*\(\d{4}[a-z]?\)[,:]?\s*/,
      ''
    );
}

/** Words that cannot end a slide bullet ("... related to"). */
const DANGLING_ENDINGS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'about', 'into', 'over', 'under', 'between', 'among', 'through', 'during',
  'after', 'before', 'against', 'within', 'without', 'upon', 'per', 'via',
  'as', 'than', 'that', 'which', 'who', 'whom', 'whose', 'and', 'or', 'but',
  'nor', 'yet', 'so', 'because', 'if', 'when', 'while', 'although', 'since',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'its',
  'their', 'this', 'these', 'those',
  // Quantifiers/determiners that need a noun after them ("... parsing both").
  'both', 'all', 'each', 'either', 'neither', 'such', 'many', 'most', 'some',
  'several', 'few', 'another', 'other', 'every', 'any', 'no', 'dan', 'atau', 'di', 'ke', 'dari',
  'dalam', 'pada', 'untuk', 'dengan', 'tentang', 'sebagai', 'oleh', 'terhadap',
  'antara', 'karena', 'yang', 'adalah', 'ialah', 'akan', 'telah', 'dapat',
  // Indonesian adverbs/connectors that cannot end a bullet either.
  'hanya', 'juga', 'serta', 'yaitu', 'yakni', 'lebih', 'sangat', 'masih',
  'sudah', 'sedang', 'bisa', 'harus', 'perlu', 'agar', 'supaya', 'kepada',
  'hingga', 'sampai', 'secara', 'merupakan', 'mengenai', 'bagi', 'tanpa',
]);

function endsDangling(bullet: string): boolean {
  const words = bullet.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z\u00C0-\u024F]/g, '');
  return DANGLING_ENDINGS.has(last);
}

/**
 * Openers that mark a clause as the continuation of the one before it, not a
 * new point ("... cara belajar yang sama, baik di level machine learning").
 */
const CONTINUATION_STARTS = new Set([
  'baik', 'yaitu', 'yakni', 'ialah', 'seperti', 'misalnya', 'contohnya',
  'termasuk', 'antara', 'serta', 'dan', 'atau', 'dengan', 'pada', 'dalam',
  'untuk', 'karena', 'sehingga', 'agar', 'supaya', 'yang', 'di', 'ke', 'dari',
  'oleh', 'bagi', 'terhadap', 'tentang', 'sebagai', 'jika', 'bila', 'ketika',
  'saat', 'setelah', 'sebelum', 'selama', 'meskipun', 'walaupun', 'tetapi',
  'tapi', 'namun', 'sedangkan', 'sementara', 'hingga', 'sampai', 'secara',
  'adalah', 'merupakan', 'that', 'which', 'whereas', 'while',
]);

/** Convert one sentence into 1–3 clean bullets. */
function toBullets(sentence: string): string[] {
  const stripped = stripAttribution(sentence);
  // Only keep the shorter version if it still says something.
  const source = countWords(stripped) >= 6 ? stripped : sentence;

  const rawBullets: string[] = [];

  for (const clause of splitClauses(source)) {
    const bullet = bulletFromClause(shortenClause(clause));
    if (countWords(bullet) < 3) continue;
    if (bullet.length > 170) continue;

    // A clause that opens with a connector continues the previous bullet; on
    // its own it reads as a fragment ("Baik di level machine learning").
    const first = bullet.split(/\s+/)[0].toLowerCase().replace(/[^a-z\u00C0-\u024F]/g, '');
    const previous = rawBullets[rawBullets.length - 1];
    if (previous && CONTINUATION_STARTS.has(first)) {
      const joined = `${previous}, ${bullet.charAt(0).toLowerCase()}${bullet.slice(1)}`;
      if (joined.length <= 170) {
        rawBullets[rawBullets.length - 1] = joined;
        continue;
      }
    }

    rawBullets.push(bullet);
  }

  // Re-join a bullet that ends mid-phrase ("... are related to") with the
  // clause that completes it. A dangling tail alone is dropped.
  const bullets: string[] = [];
  for (const bullet of rawBullets) {
    if (bullets.length > 0 && endsDangling(bullets[bullets.length - 1])) {
      const continuation = bullet.charAt(0).toLowerCase() + bullet.slice(1);
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${continuation}`;
    } else {
      bullets.push(bullet);
    }
  }
  if (bullets.length > 0 && endsDangling(bullets[bullets.length - 1])) bullets.pop();

  return bullets;
}

// ── Deck assembly ────────────────────────────────────────────────────────────

function cleanDocTitle(raw: string): string {
  return raw
    .replace(/^the project gutenberg (?:e-?book|ebook) of\s+/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickDeckTitle(sentences: string[], docTitles: string[]): string {
  const titles = docTitles.map(cleanDocTitle).filter((t) => t.length >= 4);

  if (titles.length === 1) return titles[0];
  if (titles.length === 2) {
    const joined = `${titles[0]} & ${titles[1]}`;
    if (joined.length <= 80) return joined;
  }
  if (titles.length > 2) return `Summary of ${titles.length} Documents`;

  for (const sentence of sentences.slice(0, 3)) {
    const derived = deriveTitle(sentence);
    if (countWords(derived) >= 2 && derived.length >= 10) return derived;
  }

  return 'Document Summary';
}

/**
 * Generate a slide deck from a narrative outline.
 * Produces one title slide + content slides + one conclusion slide.
 *
 * @param outline   Clean sentences from the summarizer/merge stages. Either one
 *                  string, one string per source document, or sentences grouped
 *                  per document — with groups, a slide never mixes two
 *                  documents, which otherwise produced bullets from a
 *                  different topic than the slide title.
 * @param docTitles Best-effort titles of the source documents (for the cover).
 */
export function generateSlides(
  outline: string | string[] | string[][],
  docTitles: string[] = []
): Slide[] {
  const flat: (string | string[])[] = Array.isArray(outline) ? outline : [outline];
  const groups: string[][] = flat
    .map((item) => (Array.isArray(item) ? item : [item]))
    .map((parts) =>
      parts
        .flatMap((text) =>
          splitSentences(text)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        )
    )
    .map((sentences) => {
      let usable = sentences.filter(
        (s) =>
          countWords(s) >= 5 &&
          isUsableSentence(s) &&
          !isBoilerplate(s) &&
          !looksLikeCitation(s)
      );
      if (usable.length === 0) usable = sentences.filter((s) => countWords(s) >= 4);
      return usable;
    })
    .filter((g) => g.length > 0);

  const sentences = groups.flat();
  if (sentences.length === 0) return [];

  const slides: Slide[] = [];
  let nextId = 1;
  const usedTitles = new Set<string>();
  const usedBullets = new Set<string>();

  // ── Cover slide ────────────────────────────────────────────────────────────
  const deckTitle = pickDeckTitle(sentences, docTitles);
  usedTitles.add(normalizeKey(deckTitle));

  const uniqueDocTitles = [...new Set(docTitles.map(cleanDocTitle).filter(Boolean))];
  const sourceBullets =
    uniqueDocTitles.length > 1
      ? uniqueDocTitles.slice(0, 4).map((t) => (t.length > 70 ? `${t.slice(0, 67)}…` : t))
      : [];

  slides.push({
    id: String(nextId++),
    type: 'title',
    title: deckTitle,
    bullets: sourceBullets,
    notes: sentences.slice(0, 2).join(' '),
    icon: '🗂️',
  });

  // ── Reserve the tail for the closing slide ────────────────────────────────
  // The tail is taken from the end of the outline, which is the last document
  // when the input is grouped.
  const tailCount = sentences.length >= 10 ? 3 : Math.min(2, Math.max(1, sentences.length - 1));
  const bodySentences = sentences.slice(0, Math.max(1, sentences.length - tailCount));
  const tail = sentences.slice(Math.max(1, sentences.length - tailCount));

  // ── Content slides ─────────────────────────────────────────────────────────
  const MAX_CONTENT_SLIDES = 12;
  const MAX_CHUNK = 4;
  const MIN_CHUNK = 2;

  // Grouped input: walk each document in order and chunk it on its own, so a
  // slide never carries sentences from two sources. A group is never mixed with
  // another one to fill a slide — a stub slide is dropped instead, because a
  // slide titled after one topic must not carry another document's bullet.
  const chunks: { group: number; sentences: string[] }[] = [];
  const budget = new Set(bodySentences);

  groups.forEach((group, groupIndex) => {
    const own = group.filter((s) => budget.has(s));
    if (own.length === 0) return;

    // Aim for ~3 sentences per slide, then adjust so the group does not end on
    // a single leftover sentence ("2, 2, 1" reads worse than "3, 2").
    const target = Math.max(1, Math.ceil(own.length / 3));
    let size = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.ceil(own.length / target)));
    if (size > MIN_CHUNK && own.length % size === 1) size -= 1;

    for (let i = 0; i < own.length; i += size) {
      chunks.push({ group: groupIndex, sentences: own.slice(i, i + size) });
    }
  });

  // Keep the deck readable: merge neighbouring chunks from the same document
  // while there are too many slides. Never merge across documents.
  while (chunks.length > MAX_CONTENT_SLIDES) {
    let merged = false;
    for (let i = chunks.length - 2; i >= 0; i--) {
      const a = chunks[i];
      const b = chunks[i + 1];
      if (a.group === b.group && a.sentences.length + b.sentences.length <= MAX_CHUNK + 1) {
        a.sentences = [...a.sentences, ...b.sentences];
        chunks.splice(i + 1, 1);
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }

  const contentSlides: Slide[] = [];
  const contentGroups: number[] = [];

  for (const { group: groupIndex, sentences: chunk } of chunks) {
    if (chunk.length === 0) continue;

    // Title: first sentence that yields a title not already used.
    let title = '';
    for (const sentence of chunk) {
      const candidate = deriveTitle(sentence);
      if (candidate && countWords(candidate) >= 2 && !usedTitles.has(normalizeKey(candidate))) {
        title = candidate;
        break;
      }
    }
    if (!title) {
      const fallback = keywordTitle(chunk.join(' '));
      title = fallback && !usedTitles.has(normalizeKey(fallback))
        ? fallback
        : deriveTitle(chunk[0]);
    }
    if (!title) title = 'Key Points';
    usedTitles.add(normalizeKey(title));

    // Bullets: every clause of every sentence, deduplicated, max 4.
    const bullets: string[] = [];
    for (const sentence of chunk) {
      for (const bullet of toBullets(sentence)) {
        const key = normalizeKey(bullet);
        if (key === normalizeKey(title)) continue;
        if (usedBullets.has(key)) continue;
        if (bullets.some((b) => normalizeKey(b) === key)) continue;
        bullets.push(bullet);
        if (bullets.length >= 4) break;
      }
      if (bullets.length >= 4) break;
    }

    if (bullets.length === 0) continue;

    for (const bullet of bullets) usedBullets.add(normalizeKey(bullet));

    contentSlides.push({
      id: String(nextId++),
      type: 'content',
      title,
      bullets,
      notes: chunk.join(' '),
      icon: suggestIcon(`${title} ${chunk.join(' ')}`),
    });
    contentGroups.push(groupIndex);
  }

  // Fold one-bullet slides into the previous slide instead of showing a stub —
  // but only within the same document, so a fold never mixes two sources.
  const merged: Slide[] = [];
  const mergedGroups: number[] = [];
  for (let i = 0; i < contentSlides.length; i++) {
    const slide = contentSlides[i];
    const previous = merged[merged.length - 1];
    const previousGroup = mergedGroups[mergedGroups.length - 1];
    if (slide.bullets.length < 2 && previous && previousGroup === contentGroups[i]) {
      // The editor allows up to five bullets per slide.
      const room = 5 - previous.bullets.length;
      if (room > 0) {
        previous.bullets = [...previous.bullets, ...slide.bullets.slice(0, room)];
        previous.notes = `${previous.notes} ${slide.notes}`.trim();
        continue;
      }
    }
    // A one-bullet slide from another document would be a stub; drop it.
    if (slide.bullets.length < 2 && merged.length > 0) continue;
    merged.push(slide);
    mergedGroups.push(contentGroups[i]);
  }

  slides.push(...merged);

  // ── Closing slide ──────────────────────────────────────────────────────────
  const takeawayBullets: string[] = [];
  for (const sentence of tail) {
    for (const bullet of toBullets(sentence)) {
      const key = normalizeKey(bullet);
      if (usedBullets.has(key)) continue;
      if (takeawayBullets.some((b) => normalizeKey(b) === key)) continue;
      takeawayBullets.push(bullet);
      if (takeawayBullets.length >= 3) break;
    }
    if (takeawayBullets.length >= 3) break;
  }

  if (takeawayBullets.length > 0) {
    slides.push({
      id: String(nextId++),
      type: 'conclusion',
      title: 'Key Takeaways',
      bullets: takeawayBullets,
      notes: tail.join(' '),
      icon: '🏁',
    });
  }

  return slides;
}
