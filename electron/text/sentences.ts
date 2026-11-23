/**
 * electron/text/sentences.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Sentence and clause segmentation that survives real-world documents:
 * abbreviations ("et al.", "Vol."), initials ("J. Smith"), decimals (3.14),
 * and text where the PDF layer inserted hard line breaks mid-sentence.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Abbreviations whose trailing period does NOT end a sentence. */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'mt',
  'no', 'nos', 'vol', 'vols', 'fig', 'figs', 'eq', 'eqs', 'ref', 'refs',
  'pp', 'p', 'ed', 'eds', 'al', 'etc', 'vs', 'cf', 'approx', 'ca',
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'assoc', 'gov', 'min',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'i.e', 'e.g', 'u.s', 'u.k', 'a.m', 'p.m',
]);

function endsWithAbbreviation(before: string): boolean {
  // Single capital letter = initial, e.g. "J. Smith" / "A. Wahyudi"
  if (/(?:^|[\s(])[A-Z]$/.test(before)) return true;

  const match = before.match(/([A-Za-z][A-Za-z.]*)$/);
  if (!match) return false;
  const word = match[1].toLowerCase().replace(/\./g, '');
  return ABBREVIATIONS.has(word);
}

/**
 * Split prose into sentences.
 * Newlines are usually ordinary whitespace, because PDF/Word extraction breaks
 * lines in the middle of a sentence. But slide-deck PDFs and bulleted documents
 * have real line boundaries with no full stop at all, so a line break is kept as
 * a boundary when the next line clearly starts something new.
 */
export function splitSentences(text: string): string[] {
  const blocks = joinSoftLines(text);
  const out: string[] = [];
  for (const block of blocks) {
    out.push(...splitBlock(block));
  }
  return out;
}

/** Words that leave a line hanging — the next line continues the phrase. */
const CONTINUATION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'with', 'for',
  'by', 'from', 'as', 'than', 'that', 'which', 'who', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'has', 'have', 'had', 'not', 'its', 'their',
  'this', 'these', 'those', 'can', 'will', 'would', 'should', 'may', 'might',
  'must', 'very', 'more', 'most', 'such', 'into', 'over', 'under', 'about',
  'between', 'during', 'through', 'without', 'within',
  // Indonesian function words
  'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'dalam', 'pada', 'untuk', 'dengan',
  'oleh', 'terhadap', 'bahwa', 'ini', 'itu', 'adalah', 'ialah', 'akan', 'telah',
  'dapat', 'bisa', 'juga', 'serta', 'karena', 'sehingga', 'jika', 'ketika',
  'saat', 'setelah', 'sebelum', 'agar', 'supaya', 'secara', 'para', 'bagi',
  'tanpa', 'hingga', 'sampai', 'tentang', 'sebagai', 'antara', 'merupakan',
  'meliputi', 'terdiri', 'yaitu', 'yakni',
]);

/** Strip a leading list marker ("•", "-", "1.", "a)", "o") from a line. */
function stripListMarker(line: string): string {
  return line
    .replace(
      /^\s*(?:[•·▪◦‣●*]\s*|[-–—]\s+|\d{1,2}[.)]\s+|\d{1,2}-\s+|[a-hA-H][.)]\s+|o\s+(?=[A-Z\u00C0-\u00DE]))/,
      ''
    )
    .trim();
}

/**
 * Re-join lines that a renderer broke mid-sentence, and keep the boundaries
 * that separate list items, headings and sentences.
 */
function joinSoftLines(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(stripListMarker)
    .filter((line) => line.length > 0);

  const blocks: string[] = [];

  for (const line of lines) {
    const prev = blocks[blocks.length - 1];

    if (prev === undefined) {
      blocks.push(line);
      continue;
    }

    const prevLastChar = prev.slice(-1);
    const prevLastWord = (prev.match(/([A-Za-z\u00C0-\u024F]+)$/)?.[1] ?? '').toLowerCase();
    const prevEndsSentence = /[.!?]/.test(prevLastChar);
    const nextStartsLower = /^[a-z\u00C0-\u024F]/.test(line);
    const nextStartsContinuation = /^[,;:)\]%]/.test(line);

    const continues =
      (!prevEndsSentence && (nextStartsLower || nextStartsContinuation)) ||
      /[,–—\-]$/.test(prevLastChar) ||
      CONTINUATION_WORDS.has(prevLastWord);

    if (continues) {
      blocks[blocks.length - 1] = `${prev} ${line}`;
    } else {
      blocks.push(line);
    }
  }

  return blocks;
}

/** Period/question/exclamation splitting of one whitespace-flat block. */
function splitBlock(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];

  const out: string[] = [];
  let buffer = '';

  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    buffer += ch;

    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // A sentence ends when the terminator is followed by whitespace and a new
    // word. Lowercase starters are allowed too: extracted text often contains
    // "… in life. everyday life" where the capital was lost.
    const rest = flat.slice(i + 1);
    const next = rest.match(/^\s+([A-Za-z0-9"'“”‘’(¡¿\u00C0-\u024F])/);
    if (!next) continue;

    const before = buffer.slice(0, -1);
    if (ch === '.' && endsWithAbbreviation(before)) continue;

    // Don't split a decimal ("3.14") — only when the digit follows the dot
    // immediately. A space before the digit means a numbered list item, which
    // is a legitimate sentence boundary.
    if (ch === '.' && /^\d/.test(rest)) continue;

    const sentence = buffer.trim();
    if (sentence) out.push(sentence);
    buffer = '';
  }

  const tail = buffer.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Split one sentence into shorter clauses, suitable for slide bullets.
 * Cuts on semicolons, colons and dashes, and on commas that separate two
 * complete phrases. Inline enumerations ("a) ... b) ...") become list items.
 */
export function splitClauses(sentence: string): string[] {
  // Turn inline enumerations into separate clauses so they split cleanly.
  const text = sentence
    .trim()
    .replace(/\s*[•·▪◦‣●]\s*/g, '; ')
    // "o Sesuai namanya" — lowercase-o bullets used by slide templates.
    .replace(/\s+o\s+(?=[A-Z\u00C0-\u00DE])/g, '; ')
    .replace(/\s+\((\d+)\)\s+/g, '; ')
    .replace(/\s+([a-hA-H])\)\s+/g, '; ')
    // Repairs for source text like "terkait tentang, analisis" where a list
    // marker was glued to a comma — never emit ",," or ";,".
    .replace(/\s*[,;]\s*(?=[,;])/g, '')
    .replace(/[,;]\s*$/, '');
  if (!text) return [];

  const parts: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    // Strong boundary: semicolon, colon, or a dash.
    const strong = rest.match(/^([\s\S]{3,}?)\s*[;:—–]\s+([\s\S]*)$/);
    if (strong && wordCount(strong[1]) >= 3) {
      parts.push(strong[1]);
      rest = strong[2];
      continue;
    }

    // Comma boundary — only when both sides stand on their own.
    const comma = rest.match(/^([^,]*),([\s\S]*)$/);
    if (comma) {
      const left = comma[1].trim();
      const right = comma[2].trim();
      if (canSplitAtComma(left, right)) {
        parts.push(left);
        rest = right;
        continue;
      }
    }

    parts.push(rest);
    break;
  }

  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Words that begin a dependent clause — such a clause cannot be a bullet alone. */
const SUBORDINATORS = new Set([
  'because', 'since', 'although', 'though', 'while', 'whereas', 'if', 'when',
  'whenever', 'unless', 'until', 'after', 'before', 'as', 'so', 'that', 'which',
  'who', 'whom', 'whose', 'where', 'based', 'including', 'given', 'according',
  'karena', 'sehingga', 'walaupun', 'meskipun', 'jika', 'ketika', 'saat',
  'setelah', 'sebelum', 'agar', 'supaya', 'yang', 'bahwa', 'tetapi', 'tapi',
  'namun', 'berdasarkan', 'termasuk', 'yaitu', 'yakni', 'seperti', 'misalnya',
]);

/** Prepositions that leave a phrase hanging when they end a clause. */
const TRAILING_PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about', 'into',
  'over', 'under', 'between', 'among', 'through', 'during', 'after', 'before',
  'against', 'within', 'without', 'upon', 'per', 'via', 'as', 'than', 'dan',
  'atau', 'di', 'ke', 'dari', 'dalam', 'pada', 'untuk', 'dengan', 'tentang',
  'sebagai', 'oleh', 'terhadap', 'antara',
]);

/** A clause starting with one of these is an adjunct, not a standalone point. */
const CLAUSE_STARTERS = new Set([
  'in', 'on', 'at', 'for', 'with', 'by', 'from', 'to', 'of', 'about', 'into',
  'over', 'under', 'between', 'during', 'after', 'before', 'through', 'within',
  'without', 'upon', 'per', 'via', 'as', 'than', 'and', 'or', 'but', 'so',
  'because', 'if', 'when', 'while', 'although', 'since', 'unless', 'until',
  'based', 'including', 'given', 'according',
  'dengan', 'dalam', 'pada', 'untuk', 'dari', 'di', 'ke', 'oleh', 'terhadap',
  'antara', 'karena', 'jika', 'ketika', 'setelah', 'sebelum', 'selama',
  'melalui', 'sebagai', 'tentang', 'secara',
]);

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z\u00C0-\u024F]/.test(w)).length;
}

function bare(word: string): string {
  return word.toLowerCase().replace(/[^a-z\u00C0-\u024F]/g, '');
}

function canSplitAtComma(left: string, right: string): boolean {
  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  if (leftWords.length < 5 || rightWords.length < 5) return false;

  // A dependent clause needs its main clause.
  if (SUBORDINATORS.has(bare(rightWords[0]))) return false;

  // Don't cut right after a preposition ("... related to | analyzing ...").
  if (TRAILING_PREPOSITIONS.has(bare(leftWords[leftWords.length - 1]))) return false;

  // Don't cut after a leading adjunct ("In this study | the ...").
  if (CLAUSE_STARTERS.has(bare(leftWords[0]))) return false;

  return true;
}
