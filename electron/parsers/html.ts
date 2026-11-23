/**
 * electron/parsers/html.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parse HTML files by stripping markup while keeping block structure.
 * Scripts, styles, nav and footer boilerplate are removed first.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { normalizeWhitespace } from '../text/clean';

/** Decode the entities that actually show up in saved web pages. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  };

  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

export async function parseHtml(filePath: string): Promise<string> {
  let src = fs.readFileSync(filePath, 'utf8');
  // Strip a UTF-8 BOM so the first tag is still recognised.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const stripped = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    // Headings become sentences so they don't merge into the next paragraph.
    .replace(/<(title|h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, inner: string) => {
      const text = String(inner).trim();
      if (!text) return '\n';
      return `${/[.!?:;]$/.test(text) ? text : `${text}.`}\n`;
    })
    // Block-level boundaries become line breaks so paragraphs stay separate.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|ul|ol|h[1-6]|tr|td|th|blockquote|pre|figure|figcaption|dt|dd)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    // Remaining tags are inline — drop them but keep the text.
    .replace(/<[^>]+>/g, ' ');

  return normalizeWhitespace(decodeEntities(stripped));
}
