/**
 * electron/text/clean.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared text normalisation. Every parser funnels its output through here so
 * the rest of the pipeline never sees doubled spaces, zero-width characters,
 * or words broken across line breaks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Collapse messy extracted text into clean, single-spaced lines. */
export function normalizeWhitespace(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n');

  // Words that stand alone somewhere in this document. A hyphen at a line
  // break is ambiguous: "informa-\ntion" is soft hyphenation and must be
  // joined, but "sequence-\naligned" is a real compound and must keep its
  // hyphen. The difference is visible in the document itself — "sequence"
  // appears on its own elsewhere, "informa" never does.
  //
  // Only built when the document actually has such a break, so the scan costs
  // nothing on the common path (and nothing on a 37 MB textbook).
  const standalone = new Set<string>();
  if (/[A-Za-z\u00C0-\u024F]-\s*\n/.test(text)) {
    // A word counts only when it is not itself part of a hyphenated compound —
    // otherwise "transduc-" would register "transduc" as a real word.
    const wordRe = /(?<![A-Za-z\u00C0-\u024F-])([A-Za-z\u00C0-\u024F]{3,})(?![A-Za-z\u00C0-\u024F-])/g;
    for (const match of text.matchAll(wordRe)) {
      standalone.add(match[1].toLowerCase());
    }
  }

  return (
    text
      // Soft hyphens, zero-width spaces/joiners and BOMs confuse word matching.
      .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
      // Symbol-font fallbacks that some PDF exporters emit for a bullet glyph.
      .replace(/<!>/g, ' ')
      // A bullet glyph left at the start of a line by a slide template
      // ("○ Lingkungan mencakup ...", "▪ Item"). Slide text has no list
      // structure left to preserve, so the glyph is pure noise — and when a
      // title is taken from that line it would otherwise lead the title.
      .replace(/^[ \t]*[•◦○●▪▫■□‣⁃∙►▶▸▹➢➤✓✔✗✘][ \t]+/gm, '')
      // Re-join a word broken across a line break, keeping a real compound
      // hyphen: "pro-\ngramming" -> "programming", "sequence-\naligned" ->
      // "sequence-aligned".
      //
      // A hyphen at a line break is ambiguous, so the document decides:
      //   • the prefix stands alone elsewhere ("sequence transduction") → compound
      //   • the joined form appears elsewhere ("transduction")         → soft hyphen
      //   • neither                                                   → keep the hyphen
      // Keeping the hyphen is the safe default: "segala-galanya" stays readable,
      // while dropping it silently produces "segalagalanya".
      .replace(
        /([A-Za-z\u00C0-\u024F]{2,})-\s*\n\s*([a-z\u00C0-\u024F]{2,})/g,
        (_whole, before: string, after: string) => {
          const joined = `${before}${after}`;
          if (standalone.has(before.toLowerCase())) return `${before}-${after}`;
          if (standalone.has(joined.toLowerCase())) return joined;
          return `${before}-${after}`;
        }
      )
      // A hyphen left over from a broken line before a capital: "dari- Machine"
      .replace(/([A-Za-z\u00C0-\u024F])-\s+(?=[A-Z\u00C0-\u00DE])/g, '$1 ')
      // A footnote marker glued to the next word: "26Students" -> "26 Students".
      .replace(/(\d)([A-Z][a-z\u00C0-\u024F]{2,})/g, '$1 $2')
      // Any run of horizontal whitespace (incl. non-breaking + thin spaces) -> one space
      .replace(/[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
      // A space before punctuation is always an extraction artefact.
      .replace(/ ([,;:!?%])/g, '$1')
      // Numeric citation markers ("factorization tricks [21]", "[4, 27, 28]")
      // are noise on a slide.
      .replace(/\s*\[\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\]/g, '')
      // Doubled colons come from slide templates ("Problem):: Sistem").
      .replace(/::+/g, ':')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Everything on one line, single-spaced — used before sentence analysis. */
export function toSingleLine(text: string): string {
  return normalizeWhitespace(text).replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort document title: the first line that looks like a real title
 * (not a page header, author list, journal banner, or boilerplate).
 */
export function guessDocumentTitle(text: string): string {
  const lines = normalizeWhitespace(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const isUnlikelyTitle = (line: string): boolean => {
    if (line.length < 12 || line.length > 160) return true;
    if (/^\d+$/.test(line)) return true;
    if (/^(page|hal|halaman|p\.)\s*\d+/i.test(line)) return true;
    if (/\b(ISSN|ISBN|DOI)\b/i.test(line)) return true;
    if (/https?:\/\/|www\./i.test(line)) return true;
    if (/\b[a-z0-9-]+\.(ac|co|com|org|net|edu|gov|id|io|ai|dev)\b/i.test(line)) return true;
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(line)) return true;
    if (
      /^(this work is licensed|all rights reserved|copyright|©|published|available|doi|received|accepted|revised|keywords?|key words|abstract|abstrak|introduction|pendahuluan|contents?|table of)\b/i.test(
        line
      )
    ) {
      return true;
    }
    if (/^(journal|jurnal|volume|vol\.?|issue|proceedings|conference)\b/i.test(line)) return true;
    // Label or heading ending in a colon ("Abstract:", "Keywords:").
    if (/[:：]\s*$/.test(line)) return true;
    // Author lines: several initials or a long comma-separated name list.
    if ((line.match(/\b[A-Z]\./g) ?? []).length >= 2) return true;
    if ((line.match(/,/g) ?? []).length >= 4) return true;
    // "Ikhwanul Hakim, M. Kom" / "Smith, J." — name plus academic initials.
    if (/,/.test(line) && /\b[A-Z]\./.test(line)) return true;
    // "Ikhwanul Hakim, M. Kom" — a name followed by academic initials.
    if (/^[A-Z][A-Za-z\u00C0-\u024F'’.-]+(?:\s+[A-Z][A-Za-z\u00C0-\u024F'’.-]+){0,3},\s*(?:[A-Z]\.\s*)+[A-Za-z]*$/.test(line)) {
      return true;
    }
    // Digit-heavy lines are dates, volume numbers, or tables.
    const digits = (line.match(/\d/g) ?? []).length;
    if (digits / line.length > 0.12) return true;
    // Needs a few real words.
    const words = line.split(/\s+/).filter((w) => /[A-Za-z\u00C0-\u024F]/.test(w));
    if (words.length < 3) return true;
    return false;
  };

  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i];
    if (isUnlikelyTitle(line)) continue;

    // A long title often wraps onto the next line ("... Pada Mata" /
    // "Kuliah Fisika Dasar"). Join the continuation when it is short and
    // carries no punctuation, digits or contact details.
    let title = line;
    const next = lines[i + 1];
    if (
      next &&
      title.length >= 45 &&
      !/[.!?]$/.test(title) &&
      !/[,;:]/.test(next) &&
      !/\d/.test(next) &&
      !/@|https?:/i.test(next) &&
      next.length <= 80 &&
      next.split(/\s+/).filter((w) => /[A-Za-z\u00C0-\u024F]/.test(w)).length <= 6 &&
      title.length + next.length <= 120
    ) {
      title = `${title} ${next}`;
    }

    return title.replace(/[\s.,;:–—-]+$/, '').slice(0, 120);
  }

  // Fallback: first sentence of prose.
  const firstSentence = toSingleLine(text).split(/(?<=[.!?])\s+/)[0] ?? '';
  return firstSentence.slice(0, 100).replace(/[\s.,;:–—-]+$/, '') || 'Presentation';
}
