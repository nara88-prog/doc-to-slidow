/**
 * electron/parsers/txt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Plain text — read as UTF-8 and normalise. Guards against binary files that
 * were mislabelled with a .txt extension, and cleans up plain-text "headings"
 * written with a row of === or --- underneath.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { normalizeWhitespace } from '../text/clean';

/** A line made only of one repeated punctuation character (rule / underline). */
const SEPARATOR = /^\s*([=\-*_~])\1{2,}\s*$/;
/** The underline of a setext heading ("Title" + "====="). */
const SETEXT = /^\s*([=\-~])\1{2,}\s*$/;

export async function parseTxt(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);

  // NUL bytes are a reliable sign of a binary file, not text.
  if (buffer.includes(0)) {
    throw new Error('this file contains binary data, not readable text');
  }

  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];

    // "Title" followed by "=====" — keep the title, turn it into a sentence
    // boundary, and drop the underline.
    if (next && SETEXT.test(next) && line.trim().length > 0) {
      const heading = line.trim();
      out.push(/[.!?:;]$/.test(heading) ? heading : `${heading}.`);
      i++;
      continue;
    }

    if (SEPARATOR.test(line)) continue;
    out.push(line);
  }

  return normalizeWhitespace(out.join('\n'));
}
