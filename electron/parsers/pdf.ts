/**
 * electron/parsers/pdf.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parse PDF files using the `pdf-parse` library (pure JS, no native binaries).
 *
 * The library's default page renderer concatenates text runs with no separator
 * (`text += item.str`), which is why extracted PDFs came out as
 * "inimenjadikanfunctionsegala". We supply our own renderer that reads the text
 * matrix of every run and inserts a space when there is a real horizontal gap,
 * and a newline when the baseline moves. The result is normal prose.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { normalizeWhitespace } from '../text/clean';

interface PdfTextItem {
  str?: string;
  /** [scaleX, skewY, skewX, scaleY, x, y] */
  transform?: number[];
  width?: number;
  height?: number;
}

interface PdfPageData {
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (
  data: Buffer,
  options?: Record<string, unknown>
) => Promise<{ text: string; numpages: number }>;

/**
 * Render one PDF page to text, preserving word and line boundaries.
 * pdf.js emits one item per text run; runs on the same baseline that are
 * separated by more than a fraction of the font size are separate words.
 */
function renderPage(pageData: PdfPageData): Promise<string> {
  return pageData
    .getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
    .then((content) => {
      let out = '';
      let prev: { x: number; y: number; w: number; size: number } | null = null;

      for (const item of content.items) {
        const raw = item.str ?? '';
        if (!raw) continue;

        const transform = item.transform ?? [];
        const x = transform[4] ?? 0;
        const y = transform[5] ?? 0;
        // Vertical scale of the text matrix = effective font size.
        const size = Math.abs(transform[3] ?? 0) || item.height || 10;
        const w = item.width ?? 0;

        if (prev) {
          const dy = Math.abs(y - prev.y);
          if (dy > Math.max(2.5, size * 0.6)) {
            // Different baseline: a new line. (Threshold sits above superscript
            // and subscript offsets so those stay on the same line.)
            out += '\n';
          } else {
            const gap = x - (prev.x + prev.w);
            const needsSpace = gap > size * 0.14;
            const alreadySpaced = /\s$/.test(out) || /^\s/.test(raw);
            if (needsSpace && !alreadySpaced) out += ' ';
          }
        }

        out += raw;
        prev = { x, y, w, size };
      }

      return out;
    });
}

export async function parsePdf(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer, { pagerender: renderPage });

  const rawLines = data.text.split('\n').map((l) => l.trim());

  // Count how often each line occurs. A short line repeated three or more
  // times is a running header/footer (journal name, chapter title, ...).
  const counts = new Map<string, number>();
  for (const line of rawLines) {
    if (!line) continue;
    const key = line.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lines = rawLines.filter((line) => {
    if (!line) return false;
    // Page numbers, alone or "Page 3 of 12".
    if (/^\d{1,4}$/.test(line)) return false;
    if (/^page\s+\d+(\s*(of|\/)\s*\d+)?$/i.test(line)) return false;

    const key = line.toLowerCase();
    if ((counts.get(key) ?? 0) >= 3 && line.length < 90) return false;

    return true;
  });

  return normalizeWhitespace(lines.join('\n'));
}
