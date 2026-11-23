/**
 * electron/parsers/docx.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parse .docx files using `mammoth` — converts Word XML to plain text,
 * preserving paragraph structure as newlines.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import mammoth from 'mammoth';
import { normalizeWhitespace } from '../text/clean';

export async function parseDocx(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  // Keep one line per paragraph: line breaks carry heading information that
  // the title detector relies on. Whitespace inside a line is normalised later.
  const lines = result.value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return normalizeWhitespace(lines.join('\n'));
}
