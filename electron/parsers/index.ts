/**
 * electron/parsers/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dispatches file parsing to the right format-specific parser.
 * Returns clean plain UTF-8 text suitable for the summarizer.
 *
 * Every parser's output passes through `normalizeWhitespace` here, so no
 * format can leak doubled spaces or glued words into the rest of the pipeline.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from 'path';
import { normalizeWhitespace } from '../text/clean';
import { parsePdf } from './pdf';
import { parseDocx } from './docx';
import { parsePptx } from './pptx';
import { parseTxt } from './txt';
import { parseMd } from './md';
import { parseHtml } from './html';

const EXT_MAP: Record<string, (fp: string) => Promise<string>> = {
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.pptx': parsePptx,
  '.txt': parseTxt,
  '.md': parseMd,
  '.markdown': parseMd,
  '.html': parseHtml,
  '.htm': parseHtml,
};

/**
 * Parse a supported document file and return its plain text.
 * Throws with a descriptive message if the format is unsupported or the file
 * cannot be read.
 */
export async function parseFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const parser = EXT_MAP[ext];
  if (!parser) throw new Error(`Unsupported file type: ${ext}`);
  return normalizeWhitespace(await parser(filePath));
}
