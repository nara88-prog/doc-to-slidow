/**
 * electron/parsers/md.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parse Markdown files: strip fences, links and formatting — return plain text.
 *
 * Headings and list items are turned into sentences (they get a full stop) so
 * the summarizer can treat each bullet as a discrete idea instead of gluing a
 * whole list into one run-on line.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { normalizeWhitespace } from '../text/clean';

function endSentence(value: string): string {
  const text = value.trim();
  if (!text) return text;
  return /[.!?:;]$/.test(text) ? text : `${text}.`;
}

export async function parseMd(filePath: string): Promise<string> {
  let src = fs.readFileSync(filePath, 'utf8');
  // A UTF-8 BOM would defeat every `^`-anchored pattern below.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const text = src
    // Fenced code blocks are not prose.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // Inline code keeps its text.
    .replace(/`([^`]*)`/g, '$1')
    // Images → alt text; links → label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Reference-style links.
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Emphasis and strikethrough markers.
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // Horizontal rules.
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')
    // Inline HTML.
    .replace(/<[^>]+>/g, ' ')
    // Blockquotes.
    .replace(/^\s*>\s?/gm, '')

  // Headings and list items become individual sentences.
  const withStructure = text
    .replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => endSentence(heading))
    .replace(/^\s*[-*+]\s+(.+)$/gm, (_, item: string) => endSentence(item))
    .replace(/^\s*\d+[.)]\s+(.+)$/gm, (_, item: string) => endSentence(item))
    // Table pipes read better as commas.
    .replace(/^\s*\|/gm, '')
    .replace(/\|\s*$/gm, '')
    .replace(/\s*\|\s*/g, ', ');

  return normalizeWhitespace(withStructure);
}
