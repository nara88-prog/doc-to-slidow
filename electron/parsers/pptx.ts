/**
 * electron/parsers/pptx.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parse .pptx files by reading the ZIP archive with Node's built-in `fs` and
 * the `adm-zip` library.  Extracts text from each slide's XML.
 * No binary dependency required.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { normalizeWhitespace } from '../text/clean';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip') as new (data: Buffer) => {
  getEntries(): { entryName: string; getData(): Buffer }[];
};

/** Extract all text from a PPTX (which is a ZIP of XML files). */
export async function parsePptx(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const slideTexts: string[] = [];

  for (const entry of entries) {
    // Slide XML files live at ppt/slides/slide*.xml
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)) continue;

    const xml = entry.getData().toString('utf8');

    // One line per paragraph (<a:p>) keeps titles and body text distinct.
    // Runs are reassembled carefully: PowerPoint splits words across runs for
    // formatting ("c" + "omputer"), and some exporters drop the space between
    // runs ("label" + "asli"). A single letter before a word is a split word;
    // anything longer gets a separating space.
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((block) =>
        joinRuns(
          [...block.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) =>
            decodeXmlEntities(m[1])
          )
        ).trim()
      )
      .filter((t) => t.length > 0);

    if (paragraphs.length > 0) slideTexts.push(paragraphs.join('\n'));
  }

  // One slide per line keeps slide titles detectable.
  return normalizeWhitespace(slideTexts.join('\n'));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Reassemble the text runs of one paragraph without gluing words together. */
function joinRuns(runs: string[]): string {
  let out = '';
  let previous = '';

  for (const run of runs) {
    if (!run) continue;

    if (out.length > 0) {
      const prevChar = out.slice(-1);
      const nextChar = run.charAt(0);
      const prevEndsSpace = /\s/.test(prevChar);
      const nextStartsSpace = /\s/.test(nextChar);
      const singleLetter = /^[A-Za-z\u00C0-\u024F]$/.test(previous);
      const noSpaceAfter = /[(\u2018\u201C]$/.test(prevChar);
      const noSpaceBefore = /^[),.;:!?%\u2019\u201D\]}]/.test(nextChar);
      const wordish =
        /[A-Za-z0-9\u00C0-\u024F]/.test(prevChar) && /[A-Za-z0-9\u00C0-\u024F(]/.test(nextChar);
      // "label:Value" and "item,next" are two runs with the space dropped.
      const missingAfterPunctuation =
        /[,;:]/.test(prevChar) && /[A-Za-z0-9\u00C0-\u024F(]/.test(nextChar);

      if (
        !prevEndsSpace &&
        !nextStartsSpace &&
        !singleLetter &&
        !noSpaceAfter &&
        !noSpaceBefore &&
        (wordish || missingAfterPunctuation)
      ) {
        out += ' ';
      }
    }

    out += run;
    previous = run;
  }

  return out;
}
