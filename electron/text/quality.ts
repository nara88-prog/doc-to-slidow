/**
 * electron/text/quality.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Decides which extracted sentences are worth putting on a slide.
 *
 * Real documents are full of text that is technically "content" but useless in
 * a summary: licence notices, journal headers, DOIs, page furniture, and — the
 * worst offender — bibliography entries. A naive TF-IDF pass scores those very
 * highly (author names are rare words), which is how a deck ends up made of
 * citations. These guards run before scoring so they never enter the pool.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Count words that contain at least one letter. */
export function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z\u00C0-\u024F]/.test(w)).length;
}

/** Ratio of letters to non-space characters (low = table/formula noise). */
export function letterRatio(s: string): number {
  const compact = s.replace(/\s+/g, '');
  if (compact.length === 0) return 0;
  const letters = (compact.match(/[A-Za-z\u00C0-\u024F]/g) ?? []).length;
  return letters / compact.length;
}

/**
 * Make sure a sentence ends with terminal punctuation.
 *
 * Sentences are joined with a single space when a summary is assembled. Without
 * a full stop, the next split can no longer tell where one sentence ended —
 * which is how a list of short PDF lines used to collapse into one 600-character
 * run-on that every filter then rejected.
 */
export function ensureTerminal(sentence: string): string {
  const text = sentence.trim().replace(/[,;:–—-]+$/, '');
  if (!text) return '';
  if (/[.!?]$/.test(text)) return text;
  return `${text}.`;
}

/** Lines that are document furniture rather than prose. */
const BOILERPLATE: RegExp[] = [
  /^this work is licensed\b/i,
  /^all rights reserved\b/i,
  /^copyright\b/i,
  /^©/,
  /creative commons/i,
  /^licensed under\b/i,
  /^licensee\b/i,
  /^received\s*:.*(accepted|published|revised)\s*:/i,
  /^(published|available)\s+(by|online|at)\b/i,
  /^(how to cite|to cite this|citation)\b/i,
  /^download(ed)? from\b/i,
  /^(terms|conditions)\s+(and|of)\s+(use|service)/i,
  /^privacy policy\b/i,
  /^table of contents\b/i,
  /^page\s+\d+/i,
  /^figure\s+\d+\s*[:.]/i,
  /^table\s+\d+\s*[:.]/i,
  /^keywords?\s*[:：]/i,
  /^key words\s*[:：]/i,
  /^kata kunci\s*[:：]/i,
  /^(abstract|abstrak|introduction|pendahuluan|methods?|methodology|results?|discussion|conclusions?|references|bibliography|acknowledg(e)?ments?|appendix)\s*[:：]?\s*$/i,
  /^(journal|jurnal|volume|vol\.?|issue|issn|isbn)\b/i,
  /^(proceedings|conference|workshop)\s+(of|on)\b/i,
  /^doi\s*[:：]/i,
  /^(submitted|revised|accepted)\s+\d/i,
  /^\s*[•·▪◦*]\s*/,
];

/** Phrases that only appear in publisher front matter and legal notices. */
const PUBLISHER_NOISE: RegExp[] = [
  /evaluation copies?/i,
  /no part of this publication/i,
  /stored in a retrieval system/i,
  /transmitted in any form or by any means/i,
  /corporate citizenship/i,
  /john wiley\s*&\s*sons/i,
  /library of congress/i,
  /printed in the united states/i,
  /desk copy/i,
  /review purposes only/i,
  /without (the )?(prior )?written permission/i,
  /^(vice president|executive editor|senior editor|marketing manager|production manager|cover design|cover photo|publisher|editorial assistant|project editor|content editor)\b/i,
  /^title:\s/i,
  /^this book was set in\b/i,
  /printed identification and country of origin/i,
  /carbon impact|paper specifications|charitable support/i,
  /input of users at research universities/i,
  /^his brilliance\b/i,
  /^to many, many people\b/i,
  // Licence / permission notices that sit on page 1 of many papers.
  /hereby grants? permission/i,
  /reproduce the tables and figures/i,
  /provided proper attribution/i,
  /solely for use in (journalistic|scholarly)/i,
  /permission to (make|reproduce|copy)/i,
  /^for (non-?commercial|personal|educational) (use|purposes)/i,
  // Author-contribution and funding sentences from acknowledgements.
  /spent countless/i,
  /^we (would like to |wish to )?thank\b/i,
  /^this (work|paper|research) was (supported|funded)/i,
  /^funded by\b/i,
  /^grant (no\.?|number)\b/i,
  /designed, implemented, tuned/i,
];

export function isBoilerplate(sentence: string): boolean {
  const s = sentence.trim();
  if (BOILERPLATE.some((re) => re.test(s))) return true;

  // Publisher front matter ("evaluation copies", "no part of this publication")
  // survives into long books and would otherwise fill the first slides.
  if (PUBLISHER_NOISE.some((re) => re.test(s))) return true;

  // A line with no verb-like structure and a trailing colon is a label.
  if (/:$/.test(s) && countWords(s) <= 6) return true;
  return false;
}

/**
 * Bibliography / citation / author-list detection.
 * These are the sentences that used to poison the deck.
 */
export function looksLikeCitation(sentence: string): boolean {
  const s = sentence.trim();

  // Obvious academic citation markers.
  if (/\bet\s+al\.?\b/i.test(s)) return true;
  if (/\bdoi\s*[:/]|https?:\/\//i.test(s)) return true;
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) return true;
  if (/\b(vol|no|pp?)\.?\s*\d/i.test(s)) return true;

  // Initials: "J. Smith", "A. Wahyudi", "M. Hidayat".
  const initials = (s.match(/\b[A-Z]\.(?=\s|,|&|$)/g) ?? []).length;
  if (initials >= 2) return true;

  // Ampersand-heavy author lists: "Rusli, W., Haris, A., & Yani, A."
  const amps = (s.match(/&/g) ?? []).length;
  if (amps >= 2) return true;

  // "Smith, J., & Jones, K. (2019). Title..."
  if (/\((?:\d{4})[a-z]?\)/.test(s) && (s.match(/,/g) ?? []).length >= 3) return true;

  // A run of "Name, Initial." pairs.
  if (/(?:[A-Z][a-z]+,\s*[A-Z]\.(?:\s*[A-Z]\.)?\s*(?:,|&|\band\b)\s*){2,}/.test(s)) return true;

  // Comma soup: 4+ commas in a short "sentence" with little prose.
  const commas = (s.match(/,/g) ?? []).length;
  if (commas >= 4 && countWords(s) < 45 && letterRatio(s) < 0.72) return true;

  return false;
}

/** True when a sentence can reasonably become a slide bullet. */
export function isUsableSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length < 20 || s.length > 600) return false;

  const words = countWords(s);
  if (words < 5 || words > 80) return false;

  // Needs mostly letters — rejects tables, formulas, dot leaders, indexes.
  if (letterRatio(s) < 0.62) return false;

  // Digits-heavy rows are usually data tables.
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits / Math.max(1, s.length) > 0.14) return false;

  // All-caps headings are not prose.
  const letters = s.match(/[A-Za-z\u00C0-\u024F]/g) ?? [];
  if (letters.length > 12) {
    const upper = (s.match(/[A-Z\u00C0-\u00DE]/g) ?? []).length;
    if (upper / letters.length > 0.72) return false;
  }

  // A run of shouted words ("PERKEMBANGAN TEKNOLOGI AI ...") is a heading.
  const capsWords = (s.match(/\b[A-Z]{3,}\b/g) ?? []).length;
  if (capsWords >= 3 && capsWords / Math.max(1, words) > 0.35) return false;

  // Several bullet glyphs in one "sentence" means it is a list, not prose.
  if ((s.match(/[•·▪◦‣]/g) ?? []).length >= 2) return false;

  // File names and URLs are not content.
  if (/\.(pdf|docx?|pptx?|xlsx?|csv|zip|png|jpe?g)\b/i.test(s) && words < 12) return false;

  // Needs at least one likely verb or copula to be a real sentence.
  // (Fragments like "Figure 4: results" are already filtered above.)
  return true;
}

/**
 * Drop the bibliography at the end of a document.
 * Only cuts when there is still substantial content before it, so a document
 * that is *entirely* a reference list is left alone (the other filters handle it).
 */
/**
 * Cut the tail matter — acknowledgements, then references — off a document.
 *
 * Acknowledgements matter as much as the bibliography: they are full of names,
 * thanks and "so-and-so designed this" sentences that score highly in TF-IDF
 * and read as nonsense on a slide. Both live at the end, so one cut handles
 * them. The cut only happens when enough real prose remains.
 */
export function stripReferenceSection(text: string): string {
  const re =
    /(?:^|\n)\s*(references|bibliography|works cited|literature cited|daftar pustaka|referensi|bibliograf[ií]a|acknowledg(e)?ments?|ucapan terima kasih)\b/i;
  const match = re.exec(text);
  if (!match) return text;

  const head = text.slice(0, match.index);
  const headProse = head.replace(/[^A-Za-z\u00C0-\u024F]/g, '').length;
  if (headProse < 800) return text; // too little left to be useful
  return head;
}
