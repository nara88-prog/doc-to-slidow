/**
 * electron/net/resolve.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Turn one pasted link into local documents.
 *
 * This is the only module in the app that talks to the network. It is kept free
 * of Electron imports so it can be exercised directly from Node.
 *
 * A link can be:
 *   • a direct document        → downloaded once, one document returned
 *   • a share link             → rewritten to the provider's download endpoint
 *                                (Google Drive/Docs, Dropbox, OneDrive)
 *   • a listing / folder page  → every document link inside it is downloaded
 *   • a preview / login page   → reported clearly instead of being saved as a
 *                                bogus "PDF"
 *
 * Two things used to go wrong, and are handled explicitly here:
 *
 *   1. The file type was guessed from the URL extension. Hosts that serve
 *      `application/octet-stream` from `/download?id=42` produced a PDF that was
 *      saved as `.html`; the HTML parser then turned it into page furniture.
 *   2. Links without a `.pdf`-style extension were ignored entirely, so a
 *      listing page whose download buttons point at `/download/123` yielded
 *      nothing and the listing page itself ended up in the queue.
 *
 * Both are now decided by the bytes we actually received (magic numbers) plus
 * the `Content-Disposition` filename, and extension-less links are probed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip') as new (data: Buffer) => {
  getEntries(): { entryName: string }[];
};

/** File types the rest of the app can parse. */
export const DOC_EXTS = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.html', '.htm'];

export interface ResolvedDocument {
  /** Human-readable file name, e.g. "report.pdf". */
  name: string;
  /** Local temp file the document was written to. */
  tmpPath: string;
  size: number;
  /** The URL the document was actually fetched from. */
  url: string;
}

export interface ResolveOutcome {
  ok: boolean;
  error?: string;
  documents?: ResolvedDocument[];
  warnings?: string[];
}

export interface ResolveOptions {
  /** Hard cap on documents returned for one link. */
  maxDocs?: number;
  /** How many extension-less links to probe on a listing page. */
  maxCandidates?: number;
  /** How many sub-pages of a listing page to open (depth is limited to one). */
  maxSubPages?: number;
  /** How long a single request gets to start answering (not to finish). */
  timeoutMs?: number;
  /** Total budget for resolving one link, so a bad page cannot hang the row. */
  totalTimeoutMs?: number;
}

const DEFAULTS = {
  maxDocs: 20,
  maxCandidates: 10,
  maxSubPages: 4,
  timeoutMs: 45_000,
  // Generous on purpose: this is the point at which a *stuck* link is given up
  // on, and it must not be so tight that a folder of large PDFs is truncated.
  // Downloads are individually guarded by the stall timer, so a healthy link
  // finishes far sooner.
  totalTimeoutMs: 180_000,
};

/**
 * Deliberately NOT a browser User-Agent.
 *
 * Pretending to be Chrome looks like bot traffic to several hosts (w3.org
 * answered 403 to a Chrome UA and 200 to a plain one), and a browser UA also
 * invites challenge pages. A plain, honest identifier is accepted everywhere
 * we tested and returns the raw file.
 */
const USER_AGENT = 'DocToSlides/1.0';

const ACCEPT_HEADER = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/markdown',
  'text/html;q=0.8',
  '*/*;q=0.5',
].join(',');

// ── Extension helpers ────────────────────────────────────────────────────────

/** Extension from the URL path, or from a document name in the query string. */
export function extFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const fromPath = path.extname(safeDecode(url.pathname)).toLowerCase();
    if (DOC_EXTS.includes(fromPath)) return fromPath;

    // Many download endpoints carry the name in the query:
    //   /download?file=report.pdf   /get?name=notes.docx
    for (const value of url.searchParams.values()) {
      const ext = path.extname(safeDecode(value)).toLowerCase();
      if (DOC_EXTS.includes(ext)) return ext;
    }
    return null;
  } catch {
    return null;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Extension implied by a Content-Type header. */
function extFromContentType(contentType: string): string | null {
  const type = contentType.toLowerCase();
  if (type.includes('pdf')) return '.pdf';
  if (type.includes('wordprocessingml')) return '.docx';
  if (type.includes('presentationml')) return '.pptx';
  if (type.includes('msword')) return '.docx';
  if (type.includes('ms-powerpoint')) return '.pptx';
  if (type.includes('markdown')) return '.md';
  if (type.includes('text/plain')) return '.txt';
  if (type.includes('html') || type.includes('xhtml')) return '.html';
  return null;
}

/** File name from a `Content-Disposition` header, including RFC 5987 form. */
export function filenameFromDisposition(header: string): string | null {
  if (!header) return null;

  const extended = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (extended) {
    const raw = extended[2].trim().replace(/^"|"$/g, '');
    const decoded = safeDecode(raw);
    if (decoded) return decoded;
  }

  const plain = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  if (plain) {
    const raw = (plain[1] ?? plain[2] ?? '').trim();
    if (raw) return safeDecode(raw);
  }
  return null;
}

// ── Share-link normalisation ─────────────────────────────────────────────────

export interface NormalizedLink {
  /** URL to fetch. */
  url: string;
  /** Set when the link cannot be resolved at all. */
  unsupported?: string;
  /** Set when the link points at a Google Drive folder: list its contents. */
  driveFolderId?: string;
}

/** Google file kinds, which decide the export endpoint. */
export type GoogleKind = 'file' | 'document' | 'presentation' | 'spreadsheet' | 'form' | 'drawing';

/** Path shapes that identify a Google file, most specific first. */
const GOOGLE_PATHS: Array<[RegExp, GoogleKind]> = [
  [/\/document\/(?:u\/\d+\/)?d\/([\w-]+)/, 'document'],
  [/\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/, 'presentation'],
  [/\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/, 'spreadsheet'],
  [/\/forms\/(?:u\/\d+\/)?d\/([\w-]+)/, 'form'],
  [/\/drawings\/(?:u\/\d+\/)?d\/([\w-]+)/, 'drawing'],
  [/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/, 'file'],
];

/**
 * The URL that actually returns a file for a Google id.
 *
 * Native Google files have no download link of their own — they have to be
 * exported. A "view" link returns the editor's HTML, which is how the viewer
 * page used to end up saved as the document.
 */
export function googleDownloadUrl(id: string, kind: GoogleKind): string | null {
  switch (kind) {
    case 'document':
      return `https://docs.google.com/document/d/${id}/export?format=docx`;
    case 'presentation':
      return `https://docs.google.com/presentation/d/${id}/export/pptx`;
    // Sheets cannot be parsed directly; PDF is a format this app reads.
    case 'spreadsheet':
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`;
    case 'form':
    case 'drawing':
      return null;
    default:
      return `https://drive.google.com/uc?export=download&id=${id}`;
  }
}

/**
 * Rewrite provider share links to their direct-download equivalents.
 * A "view" link returns an HTML viewer, which is exactly the "wrong document"
 * problem: the deck would be built from the viewer's chrome.
 */
export function normalizeShareLink(rawUrl: string): NormalizedLink {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isGoogle =
    host === 'drive.google.com' ||
    host === 'drive.usercontent.google.com' ||
    host === 'docs.google.com';

  // ── Google Drive / Docs ───────────────────────────────────────────────────
  if (isGoogle) {
    // A folder is a container, not a document: its contents have to be listed.
    // This covers /drive/folders/ID, /drive/u/0/folders/ID and ?folder=ID.
    const folder = url.pathname.match(
      /\/drive\/(?:u\/\d+\/)?(?:mobile\/)?folders\/([\w-]+)/
    );
    if (folder) return { url: rawUrl, driveFolderId: folder[1] };

    const folderParam = url.searchParams.get('folder') ?? url.searchParams.get('folderId');
    if (folderParam && /^[\w-]+$/.test(folderParam)) {
      return { url: rawUrl, driveFolderId: folderParam };
    }

    for (const [pattern, kind] of GOOGLE_PATHS) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      const download = googleDownloadUrl(match[1], kind);
      if (!download) {
        return {
          url: rawUrl,
          unsupported:
            kind === 'form'
              ? 'Google Forms cannot be converted to slides — export the responses or the form summary and add that file instead.'
              : 'Google Drawings cannot be converted to slides — export it as PDF and add that file instead.',
        };
      }
      return { url: download };
    }

    const id = url.searchParams.get('id');
    if (id && /^[\w-]+$/.test(id)) {
      return { url: googleDownloadUrl(id, 'file') as string };
    }

    // /drive/u/0/my-drive and friends carry no file to fetch.
    if (host === 'drive.google.com' && /^\/(?:drive\/)?(?:u\/\d+\/)?(?:my-drive|shared-with-me|recent|starred|trash)?\/?$/.test(url.pathname)) {
      return {
        url: rawUrl,
        unsupported:
          'That is the Google Drive home page, not a file or folder. Open the folder you want, then copy its link from the address bar.',
      };
    }
  }

  // ── Dropbox ───────────────────────────────────────────────────────────────
  if (host.endsWith('dropbox.com')) {
    url.searchParams.set('dl', '1');
    return { url: url.toString() };
  }

  // ── OneDrive ──────────────────────────────────────────────────────────────
  if (host === '1drv.ms' || host.endsWith('onedrive.live.com')) {
    url.searchParams.set('download', '1');
    return { url: url.toString() };
  }

  return { url: rawUrl };
}

// ── Fetching ─────────────────────────────────────────────────────────────────

/**
 * Minimal cookie jar. Many document portals (e-learning systems, intranets)
 * hand out a session cookie on the listing page and refuse the download
 * without it — with a plain `fetch` every file link then returns 403.
 */
const cookieJar = new Map<string, Map<string, string>>();

function jarFor(rawUrl: string): Map<string, string> | null {
  try {
    return cookieJar.get(new URL(rawUrl).hostname) ?? null;
  } catch {
    return null;
  }
}

function rememberCookies(rawUrl: string, res: Response): void {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter((value): value is string => Boolean(value));
  if (list.length === 0) return;

  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return;
  }

  let jar = cookieJar.get(host);
  if (!jar) {
    jar = new Map<string, string>();
    cookieJar.set(host, jar);
  }

  for (const raw of list) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

interface Resource {
  contentType: string;
  disposition: string;
  buffer: Buffer;
  finalUrl: string;
}

/**
 * How long a host gets to start answering.
 *
 * This is a *response* deadline, not a download deadline. On a real connection
 * the first request to a large file can spend ten seconds on DNS, TLS and
 * Drive's redirect chain before the first byte arrives, and four parallel
 * downloads can each wait longer than that. A 20 s cap here silently dropped
 * one file out of a five-file Drive folder.
 */
const RESPONSE_TIMEOUT_MS = 45_000;

/**
 * How long a transfer may go silent before it is abandoned.
 *
 * The timer is reset on every chunk, so a 24 MB PDF on a slow link is never
 * cut off for being big — only for being dead. This is the distinction that
 * used to break large Drive files: a single wall-clock timeout covered both
 * "did it answer?" and "did it finish?", and a healthy 24 MB download took
 * longer than the cap.
 */
const STALL_TIMEOUT_MS = 30_000;

/** Send a request and read the whole body under the two deadlines above. */
async function requestWithBody(
  url: string,
  headers: Record<string, string>,
  responseTimeoutMs: number
): Promise<{ res: Response; buffer: Buffer }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (ms: number, reason: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(reason)), ms);
  };

  try {
    arm(responseTimeoutMs, 'The link timed out. Check your connection and try again.');

    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers });

    if (!res.body) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { res, buffer };
    }

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    for (;;) {
      // Reset on every read: progress means the transfer is alive.
      arm(
        STALL_TIMEOUT_MS,
        'The download stalled. Check your connection and try again.'
      );
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    }

    return { res, buffer: Buffer.concat(chunks, total) };
  } catch (err) {
    // undici may report a bare "aborted" instead of the reason we gave it.
    const reason = controller.signal.aborted ? controller.signal.reason : undefined;
    throw reason instanceof Error ? reason : err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchResource(
  url: string,
  timeoutMs: number,
  referer?: string,
  depth = 0
): Promise<Resource> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: ACCEPT_HEADER,
    'Accept-Language': 'en,*;q=0.5',
  };

  const jar = jarFor(url);
  if (jar && jar.size > 0) {
    headers.Cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  if (referer) headers.Referer = referer;

  const responseTimeout = Math.min(timeoutMs, RESPONSE_TIMEOUT_MS);
  let attempt = await requestWithBody(url, headers, responseTimeout);

  // Some hosts reject any identifiable client with 403 and answer a bare
  // request fine. One retry with the absolute minimum costs nothing.
  if (attempt.res.status === 403) {
    const bare: Record<string, string> = {};
    if (referer) bare.Referer = referer;
    if (headers.Cookie) bare.Cookie = headers.Cookie;
    const retry = await requestWithBody(url, bare, responseTimeout);
    if (retry.res.ok) attempt = retry;
  }

  const { res, buffer } = attempt;
  rememberCookies(res.url || url, res);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }

  if (buffer.length === 0) throw new Error('The link returned an empty response.');

  let resource: Resource = {
    contentType: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    buffer,
    finalUrl: res.url || url,
  };

  // Google Drive answers a large public file with a "can't scan this file for
  // viruses" interstitial instead of the bytes. It is a real HTML form, so the
  // only reliable way through is to submit that form's own fields — guessing
  // `confirm=<token>` alone fails because Drive also requires `id` and `uuid`.
  if (isGoogleHost(url) && isHtml(buffer)) {
    const target = driveConfirmTarget(
      buffer.toString('utf8', 0, Math.min(buffer.length, 300_000)),
      res.url || url
    );
    if (target && depth < 3) {
      resource = await fetchResource(target, timeoutMs, referer, depth + 1);
    }
  }

  return resource;
}

/**
 * Fetch once, and retry with a short pause if it failed.
 *
 * Drive drops a transfer now and then, and a five-file folder used to come back
 * with four because one download lost its race against the others. A retry
 * costs a few seconds and removes that whole class of failure; the pause keeps
 * a throttled host from rejecting the retry as well. A 4xx is a real answer
 * (gone, private, wrong type) and is not worth repeating.
 */
async function fetchWithRetry(
  url: string,
  timeoutMs: number,
  referer?: string,
  attempts = 3
): Promise<Resource> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchResource(url, timeoutMs, referer);
    } catch (err) {
      lastError = err;
      if (/^HTTP 4\d\d/.test((err as Error).message ?? '')) throw err;
      if (attempt < attempts) await pause(attempt * 1500);
    }
  }
  throw lastError;
}

/** Wait, without blocking the event loop. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Any Google host that serves Drive content or its interstitials. */
function isGoogleHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'drive.google.com' ||
      host === 'drive.usercontent.google.com' ||
      host === 'docs.google.com'
    );
  } catch {
    return false;
  }
}

/**
 * Rebuild the Drive download form as a GET request.
 * Returns null when the page is not an interstitial (e.g. a sign-in wall).
 */
export function driveConfirmTarget(html: string, currentUrl: string): string | null {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (form) {
    const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(form[1])?.[1] ?? '';
    const params = new URLSearchParams();
    const inputRe = /<input\b[^>]*>/gi;
    let input: RegExpExecArray | null;
    while ((input = inputRe.exec(form[2])) !== null) {
      const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(input[0])?.[1];
      const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(input[0])?.[1] ?? '';
      if (name) params.set(name, decodeEntities(value));
    }
    if ([...params.keys()].length > 0) {
      let target: URL;
      try {
        target = action ? new URL(action, currentUrl) : new URL(currentUrl);
      } catch {
        return null;
      }
      for (const [key, value] of params) target.searchParams.set(key, value);
      return target.toString();
    }
  }

  // Some variants hand out a ready-made link instead of a form.
  const link = /href\s*=\s*["']([^"']*(?:confirm=|uuid=)[^"']*)["']/i.exec(html)?.[1];
  if (link) {
    try {
      return new URL(decodeEntities(link), currentUrl).toString();
    } catch {
      /* fall through */
    }
  }

  const token = /confirm=([\w-]+)/.exec(html)?.[1];
  if (token) {
    try {
      const target = new URL(currentUrl);
      target.searchParams.set('confirm', token);
      return target.toString();
    } catch {
      return null;
    }
  }

  return null;
}

// ── Content sniffing ─────────────────────────────────────────────────────────

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buffer: Buffer, magic: number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, i) => buffer[i] === byte);
}

function isHtml(buffer: Buffer): boolean {
  const head = buffer
    .toString('utf8', 0, Math.min(buffer.length, 2048))
    .replace(/^\uFEFF/, '')
    .toLowerCase();
  return /<\s*(!doctype\s+html|html|head|body)\b/.test(head);
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32) control++;
  }
  return control / Math.max(1, sample.length) < 0.02;
}

/** Identify a ZIP container (DOCX / PPTX) by the parts it contains. */
function zipKind(buffer: Buffer): '.docx' | '.pptx' | null {
  try {
    const names = new AdmZip(buffer).getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
    if (names.some((n) => n === 'word/document.xml')) return '.docx';
    if (names.some((n) => n === 'ppt/presentation.xml')) return '.pptx';
  } catch {
    /* not a readable zip */
  }
  return null;
}

/**
 * The real type of the bytes we received.
 * Magic numbers win over headers, and headers win over the URL — servers lie in
 * both directions, but the body does not.
 */
export function sniffExtension(buffer: Buffer, contentType = '', url = ''): string | null {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return '.pdf'; // %PDF
  if (startsWith(buffer, ZIP_MAGIC) || startsWith(buffer, ZIP_EMPTY_MAGIC)) {
    return zipKind(buffer);
  }
  if (startsWith(buffer, OLE_MAGIC)) return null; // legacy .doc/.ppt — unsupported
  if (isHtml(buffer)) return '.html';

  const fromType = extFromContentType(contentType);
  if (fromType && fromType !== '.html') return fromType;

  const fromUrl = extFromUrl(url);
  if (fromUrl && fromUrl !== '.html') return fromUrl;

  if (fromType === '.html') return '.html';
  return looksLikeText(buffer) ? '.txt' : null;
}

interface Detected {
  /** 'document' = a real file; 'html' = a web page to inspect; 'unknown' = nothing usable. */
  kind: 'document' | 'html' | 'unknown';
  ext: string | null;
  name: string | null;
}

/** Decide what a fetched resource is, and what to call it. */
function detect(resource: Resource, url: string): Detected {
  const ext = sniffExtension(resource.buffer, resource.contentType, url);
  if (!ext) return { kind: 'unknown', ext: null, name: null };
  if (ext === '.html') return { kind: 'html', ext, name: nameFor(resource, url, ext) };
  return { kind: 'document', ext, name: nameFor(resource, url, ext) };
}

function nameFor(resource: Resource, url: string, ext: string): string {
  const candidates: string[] = [];

  // 1. The server's own filename is the most reliable.
  const fromHeader = filenameFromDisposition(resource.disposition);
  if (fromHeader) candidates.push(fromHeader);

  // 2. A name carried in the query string: /download?file=report.pdf
  try {
    for (const value of new URL(url).searchParams.values()) {
      if (DOC_EXTS.includes(path.extname(value).toLowerCase())) {
        candidates.push(safeDecode(value.split('/').pop() ?? value));
        break;
      }
    }
  } catch {
    /* ignore */
  }

  // 3. The last path segment.
  try {
    const base = safeDecode(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (base) candidates.push(base);
  } catch {
    /* ignore */
  }

  for (const candidate of candidates) {
    const clean = sanitizeName(candidate);
    if (!clean) continue;
    const currentExt = path.extname(clean).toLowerCase();
    if (DOC_EXTS.includes(currentExt)) {
      // Trust the sniffed extension over a wrong one in the name.
      return currentExt === ext ? clean : `${clean.slice(0, -currentExt.length)}${ext}`;
    }
    // No usable extension ("view", "42") — only keep it when it reads like a name.
    if (clean.length >= 3 && !/^\d+$/.test(clean) && currentExt === '') {
      return `${clean}${ext}`;
    }
  }

  return `document${ext}`;
}

function sanitizeName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ── Link extraction ──────────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? whole);
}

/** Every URL referenced by a page: anchors, frames, embeds and objects. */
export function extractLinks(html: string, pageUrl: string): string[] {
  // A <base href> changes how every relative URL resolves.
  let baseUrl = pageUrl;
  const baseMatch = html.match(/<base\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (baseMatch) {
    const raw = decodeEntities((baseMatch[1] ?? baseMatch[2] ?? baseMatch[3] ?? '').trim());
    try {
      baseUrl = new URL(raw, pageUrl).toString();
    } catch {
      /* keep pageUrl */
    }
  }

  const attribute =
    /<(?:a|area)\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|<(?:iframe|frame|embed)\b[^>]*?src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|<object\b[^>]*?data\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  const found: string[] = [];
  const seen = new Set<string>();

  const push = (rawValue: string): void => {
    const raw = decodeEntities(rawValue.trim());
    if (!raw) return;
    if (/^(#|mailto:|tel:|javascript:|data:|blob:)/i.test(raw)) return;

    let absolute: string;
    try {
      const url = new URL(raw, baseUrl);
      url.hash = '';
      absolute = url.toString();
    } catch {
      return;
    }

    if (!/^https?:/i.test(absolute)) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    found.push(absolute);
  };

  // Pages that *declare* the document they are about. Academic and repository
  // sites (arXiv, CiteSeer, institutional archives, most CMS "download" pages)
  // never link the file from an <a>; they publish it in metadata. Without this
  // the abstract page itself was saved as the "document".
  const declared: string[] = [];
  const metaPattern =
    /<meta\b[^>]*?(?:name|property)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']+)["']/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaPattern.exec(html)) !== null) {
    const key = metaMatch[1].toLowerCase();
    if (
      key === 'citation_pdf_url' ||
      key === 'bepress_citation_pdf_url' ||
      key === 'eprints.document_url' ||
      key === 'dc.identifier.pdf' ||
      key === 'og:document' ||
      key === 'document_location'
    ) {
      declared.push(metaMatch[2]);
    }
  }

  // <link rel="alternate" type="application/pdf" href="…">
  const linkPattern = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const tag = linkMatch[0];
    if (!/application\/pdf/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) declared.push(href[1] ?? href[2] ?? href[3] ?? '');
  }

  for (const value of declared) push(value);

  let match: RegExpExecArray | null;
  while ((match = attribute.exec(html)) !== null) {
    push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? '');
  }

  // <meta http-equiv="refresh" content="0; url=/docs/report.pdf"> is a redirect
  // that some file hosts use instead of a Location header.
  const refresh = html.match(
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']([^"']+)["']/i
  );
  if (refresh) {
    const urlPart = refresh[1].match(/url\s*=\s*(.+)$/i);
    if (urlPart) push(urlPart[1].replace(/^["']|["']$/g, ''));
  }

  return found;
}

// ── Link classification ──────────────────────────────────────────────────────

/** Extensions that are never documents (images, scripts, archives, media). */
const SKIP_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif',
  '.css', '.js', '.mjs', '.json', '.map', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.webm', '.avi', '.mov', '.wav', '.ogg',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.msi', '.dmg', '.iso',
  '.xml', '.rss', '.atom', '.rdf',
]);

/** Words in a path or query that usually point at a downloadable file. */
const DOC_HINT =
  /(?:^|[/?&=_.-])(download|downloads|getfile|get_file|file|files|attachment|attachments|document|documents|viewfile|raw|export|media|content|retrieve|fetch|pdf|docx|pptx|doc|ppt)(?:$|[/?&=_.-])/i;

/** Query parameters that carry a document identifier. */
const DOC_PARAM =
  /^(id|file|fileid|file_id|doc|docid|doc_id|document|documentid|attachment|attachmentid|download|filename|fname|name|path)$/i;

/** Path segments that are site chrome, not content. */
const NAV_NOISE =
  /(?:^|\/)(about|contact|privacy|terms|login|log-in|signin|sign-in|signup|register|search|help|faq|support|careers|news|blog|events|pricing|cookie|cookies|sitemap|rss|feed|tag|tags|category|categories|author|authors|page|wp-admin|wp-login|recent|new|latest|archive|archives|browse|popular|trending)(?:\/|$)/i;

export type LinkKind = 'document' | 'candidate' | 'page' | 'skip';

/**
 * Decide what to do with one link found on a page.
 *   document  — a known file extension, download it
 *   candidate — looks like a file endpoint, probe it
 *   page      — another HTML page, only followed one level deep
 *   skip      — image, script, archive, site chrome
 *
 * The order matters. A path such as `/pdf/1706.03762` has a "real" extension
 * as far as `path.extname` is concerned (`.03762`), so any rule keyed on
 * "has no extension" silently drops the most common download URLs on the web.
 * File-endpoint hints are therefore checked before the extension fallbacks.
 */
export function classifyLink(rawUrl: string, pageUrl: string): LinkKind {
  let url: URL;
  let page: URL;
  try {
    url = new URL(rawUrl);
    page = new URL(pageUrl);
  } catch {
    return 'skip';
  }

  const pathname = safeDecode(url.pathname);
  const ext = path.extname(pathname).toLowerCase();

  if (SKIP_EXTS.has(ext)) return 'skip';

  // An HTML link is never a document on a listing page — it is either another
  // page of the same site (a folder inside a folder) or site chrome from
  // somewhere else (help pages, sponsor pages). Downloading it only produces
  // "not a readable document" noise.
  if (ext === '.html' || ext === '.htm') {
    if (url.origin !== page.origin) return 'skip';
    if (NAV_NOISE.test(pathname)) return 'skip';
    if (pathname === page.pathname && url.search === page.search) return 'skip';
    return 'page';
  }

  if (DOC_EXTS.includes(ext)) return 'document';

  // Site chrome is never worth a request, whatever it looks like.
  if (NAV_NOISE.test(pathname)) return 'skip';

  const hasDocHint = DOC_HINT.test(pathname) || DOC_HINT.test(url.search);
  const hasDocParam = [...url.searchParams.keys()].some((key) => DOC_PARAM.test(key));
  if (hasDocHint || hasDocParam) return 'candidate';

  // Server-rendered pages (.php/.aspx/…) are pages unless they serve a file.
  const serverPage = /\.(php|asp|aspx|jsp|cgi|do|action)$/i.test(pathname);
  if (serverPage) {
    if (url.origin !== page.origin) return 'skip';
    if (pathname === page.pathname && url.search === page.search) return 'skip';
    return 'page';
  }

  // An unknown suffix is not something we can open (and SKIP_EXTS already
  // caught archives and media), so do not spend a request on it.
  if (ext !== '') return 'skip';

  if (url.origin !== page.origin) return 'skip';
  if (pathname === page.pathname && url.search === page.search) return 'skip';
  return 'page';
}

// ── Temp files ───────────────────────────────────────────────────────────────

function writeTemp(buffer: Buffer, ext: string): string {
  const tmpPath = path.join(
    os.tmpdir(),
    `doc-to-slides-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`
  );
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

// ── Concurrency ──────────────────────────────────────────────────────────────

/** Run an async fn over items with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Resolution ───────────────────────────────────────────────────────────────

function describe(resource: Resource): string {
  const type = resource.contentType.split(';')[0].trim() || 'unknown type';
  const kb = Math.max(1, Math.round(resource.buffer.length / 1024));
  return `${type}, ${kb} KB`;
}

/** Human-readable message for a failed fetch. */
function fetchErrorMessage(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (/timeout|timed out|abort/i.test(message)) {
    return 'The link timed out. Check your connection and try again.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|fetch failed|network/i.test(message)) {
    return 'You appear to be offline — connect and retry.';
  }
  if (/HTTP 401|HTTP 403/i.test(message)) {
    return 'That link is private — it needs a sign-in this app cannot provide. Download the file and add it with Browse instead.';
  }
  if (/HTTP 404|HTTP 410/i.test(message)) {
    return 'That link no longer exists (404). Check the address and try again.';
  }
  if (/HTTP 5\d\d/.test(message)) {
    return 'The server returned an error for that link. Try again in a moment.';
  }
  return message;
}

interface CollectContext {
  options: Required<ResolveOptions>;
  documents: ResolvedDocument[];
  warnings: string[];
  seenUrls: Set<string>;
  /** Epoch ms after which no new requests are started. */
  deadline: number;
  /** True once the budget ran out and a warning was recorded. */
  budgetExhausted: boolean;
}

/** Per-probe timeout: never let one candidate eat the whole budget. */
const CANDIDATE_TIMEOUT_MS = 10_000;

function budgetLeft(ctx: CollectContext): boolean {
  if (Date.now() < ctx.deadline) return true;
  if (!ctx.budgetExhausted) {
    ctx.budgetExhausted = true;
    ctx.warnings.push(
      'Stopped after reaching the time limit for this link — some documents may be missing.'
    );
  }
  return false;
}

/** Save one downloaded resource as a document, or record why it was not. */
function acceptDocument(
  resource: Resource,
  url: string,
  ctx: CollectContext,
  preferredName?: string
): boolean {
  const detected = detect(resource, url);
  if (detected.kind !== 'document' || !detected.ext) return false;
  if (ctx.documents.length >= ctx.options.maxDocs) return false;

  // A name taken from the listing (Drive titles, link text) is better than
  // "document.docx", but the extension must follow the bytes we received.
  let name = detected.name ?? `document${detected.ext}`;
  if (preferredName) {
    const base = preferredName.replace(/\.[A-Za-z0-9]{1,6}$/, '').trim();
    if (base) name = `${base}${detected.ext}`;
  }

  const tmpPath = writeTemp(resource.buffer, detected.ext);
  ctx.documents.push({
    name,
    tmpPath,
    size: resource.buffer.length,
    url,
  });
  return true;
}

// ── Google Drive folders ─────────────────────────────────────────────────────

/**
 * One child of a Drive folder.
 *
 * `embeddedfolderview` is Drive's own server-rendered listing of a public
 * folder — the same HTML the Drive web UI uses for its "list" view. Unlike the
 * main folder page (a JavaScript app) it needs no browser, no API key and no
 * sign-in, which is why a folder link can be read at all.
 */
export interface DriveEntry {
  id: string;
  name: string;
  kind: GoogleKind | 'folder';
}

/** Extract the children of a folder from its embeddedfolderview page. */
export function parseDriveFolderListing(html: string): DriveEntry[] {
  // Every entry starts with id="entry-<fileId>"; the block that follows holds
  // the link and the title, in that order.
  const marker = /id="entry-([\w-]+)"/g;
  const starts: Array<{ id: string; at: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(html)) !== null) {
    starts.push({ id: match[1], at: match.index });
  }

  const entries: DriveEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < starts.length; i++) {
    const { id, at } = starts[i];
    if (seen.has(id)) continue;
    seen.add(id);

    const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(html.length, at + 4000);
    const block = html.slice(at, end);

    const href = /<a\b[^>]*?href\s*=\s*["']([^"']+)["']/i.exec(block)?.[1] ?? '';
    const rawTitle =
      /class="flip-entry-title"[^>]*>([^<]*)</i.exec(block)?.[1] ??
      /<div[^>]*class="[^"]*title[^"]*"[^>]*>([^<]*)</i.exec(block)?.[1] ??
      '';

    const name = sanitizeName(decodeEntities(rawTitle.trim()));

    let kind: DriveEntry['kind'] = 'file';
    if (/\/drive\/(?:u\/\d+\/)?(?:mobile\/)?folders\//.test(href)) kind = 'folder';
    else if (/\/document\/d\//.test(href)) kind = 'document';
    else if (/\/presentation\/d\//.test(href)) kind = 'presentation';
    else if (/\/spreadsheets\/d\//.test(href)) kind = 'spreadsheet';
    else if (/\/forms\/d\//.test(href)) kind = 'form';
    else if (/\/drawings\/d\//.test(href)) kind = 'drawing';

    entries.push({ id, name: name || id, kind });
  }

  return entries;
}

/** File name for a folder entry, with the extension its export produces. */
function driveEntryName(entry: DriveEntry): string {
  const base = sanitizeName(entry.name || entry.id);
  const ext = path.extname(base).toLowerCase();
  if (DOC_EXTS.includes(ext)) return base;

  const implied =
    entry.kind === 'document'
      ? '.docx'
      : entry.kind === 'presentation'
        ? '.pptx'
        : entry.kind === 'spreadsheet'
          ? '.pdf'
          : '';

  if (!implied) return base;
  if (ext.length > 1 && ext.length <= 6) return `${base.slice(0, -ext.length)}${implied}`;
  return `${base}${implied}`;
}

/** A folder title that is obviously not a document (photo, video, archive). */
function isNonDocumentTitle(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return SKIP_EXTS.has(ext) && !DOC_EXTS.includes(ext);
}

/**
 * List a public Drive folder and download every document inside it.
 * Sub-folders are followed two levels deep, which covers the usual
 * "Course / Week 3 / slides.pdf" layout.
 */
async function collectFromDriveFolder(
  folderId: string,
  depth: number,
  ctx: CollectContext
): Promise<void> {
  if (depth > 2 || ctx.documents.length >= ctx.options.maxDocs) return;

  const viewUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`;

  let listing: Resource;
  try {
    listing = await fetchResource(viewUrl, ctx.options.timeoutMs);
  } catch (err) {
    if (depth === 0) throw err;
    ctx.warnings.push(`Sub-folder ${folderId} — ${fetchErrorMessage(err)}`);
    return;
  }

  const html = listing.buffer.toString('utf8');
  const entries = parseDriveFolderListing(html);

  if (entries.length === 0) {
    if (depth === 0) {
      throw new Error(
        /accounts\.google\.com|Sign in|Masuk/i.test(html)
          ? 'That Drive folder is not shared publicly. Set the folder to "Anyone with the link", then try again.'
          : 'That Drive folder is empty, or it is not shared publicly.'
      );
    }
    return;
  }

  const subFolders: DriveEntry[] = [];
  const documents: DriveEntry[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (entry.kind === 'folder') subFolders.push(entry);
    else if (entry.kind === 'form' || entry.kind === 'drawing') skipped++;
    else if (isNonDocumentTitle(entry.name)) skipped++;
    else documents.push(entry);
  }

  // Download three at a time but save each group in listing order, so the queue
  // matches the folder (01, 02, 03 …) instead of whatever finished first.
  // Grouping also bounds how many files are held in memory at once. Three
  // rather than four keeps Drive from throttling one of the streams, which used
  // to drop a file out of a five-file folder.
  const BATCH = 3;
  const picked = documents.slice(0, ctx.options.maxDocs);
  for (let start = 0; start < picked.length; start += BATCH) {
    if (ctx.documents.length >= ctx.options.maxDocs) break;
    if (!budgetLeft(ctx)) break;

    const group = picked.slice(start, start + BATCH);
    const fetched = await mapWithConcurrency(group, BATCH, async (entry) => {
      const downloadUrl =
        entry.kind === 'folder'
          ? null
          : entry.kind === 'file'
            ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(entry.id)}`
            : googleDownloadUrl(entry.id, entry.kind);

      if (!downloadUrl) {
        skipped++;
        return null;
      }
      if (ctx.seenUrls.has(downloadUrl)) return null;
      ctx.seenUrls.add(downloadUrl);

      try {
        const resource = await fetchWithRetry(
          downloadUrl,
          Math.min(ctx.options.timeoutMs, CANDIDATE_TIMEOUT_MS * 3)
        );
        return { entry, resource, downloadUrl };
      } catch (err) {
        ctx.warnings.push(`${entry.name} — ${fetchErrorMessage(err)}`);
        return null;
      }
    });

    for (const hit of fetched) {
      if (!hit) continue;
      if (ctx.documents.length >= ctx.options.maxDocs) break;
      if (!acceptDocument(hit.resource, hit.downloadUrl, ctx, driveEntryName(hit.entry))) {
        ctx.warnings.push(`${hit.entry.name} — could not be read as a document`);
      }
    }
  }

  if (depth === 0 && skipped > 0) {
    ctx.warnings.push(
      `${skipped} item${skipped === 1 ? '' : 's'} in that folder ${skipped === 1 ? 'is' : 'are'} not a document format this app can read (images, video, archives, forms) and were skipped.`
    );
  }

  for (const folder of subFolders) {
    if (ctx.documents.length >= ctx.options.maxDocs) break;
    if (!budgetLeft(ctx)) break;
    await collectFromDriveFolder(folder.id, depth + 1, ctx);
  }
}

/**
 * Open a listing page and collect the documents it points at.
 * Depth is bounded: the page itself is depth 0, and links to other pages are
 * followed exactly once so a folder → sub-folder layout still works.
 */
async function collectFromPage(
  pageUrl: string,
  pageBuffer: Buffer,
  depth: number,
  ctx: CollectContext
): Promise<void> {
  if (ctx.documents.length >= ctx.options.maxDocs) return;

  const html = pageBuffer.toString('utf8');
  const links = extractLinks(html, pageUrl);

  const documents: string[] = [];
  const candidates: string[] = [];
  const pages: string[] = [];

  for (const link of links) {
    if (ctx.seenUrls.has(link)) continue;
    const kind = classifyLink(link, pageUrl);
    if (kind === 'document') documents.push(link);
    else if (kind === 'candidate') candidates.push(link);
    else if (kind === 'page' && depth === 0) pages.push(link);
  }

  // 1. Definite documents, in parallel.
  const docResults = await mapWithConcurrency(
    documents.slice(0, ctx.options.maxDocs * 2),
    4,
    async (link) => {
      if (!budgetLeft(ctx)) return null;
      try {
        const resource = await fetchResource(link, ctx.options.timeoutMs, pageUrl);
        ctx.seenUrls.add(link);
        return acceptDocument(resource, resource.finalUrl, ctx) ? null : `${link} — not a readable document`;
      } catch (err) {
        return `${link} — ${fetchErrorMessage(err)}`;
      }
    }
  );
  for (const warning of docResults) {
    if (warning) ctx.warnings.push(warning);
  }

  // 2. Links that look like file endpoints but do not end in a known
  //    extension (/download/42, /pdf/1706.03762). Probed in parallel: on a real
  //    page there are usually several, and one slow one must not stall the rest.
  if (ctx.documents.length < ctx.options.maxDocs) {
    const probe = candidates.slice(0, ctx.options.maxCandidates).filter((link) => {
      if (ctx.seenUrls.has(link)) return false;
      ctx.seenUrls.add(link);
      return true;
    });

    const probeResults = await mapWithConcurrency(probe, 3, async (link) => {
      if (ctx.documents.length >= ctx.options.maxDocs) return null;
      if (!budgetLeft(ctx)) return null;
      try {
        const resource = await fetchResource(
          link,
          Math.min(ctx.options.timeoutMs, CANDIDATE_TIMEOUT_MS),
          pageUrl
        );
        if (acceptDocument(resource, resource.finalUrl, ctx)) return null;
        // It answered with another web page, so it was a viewer, not a file.
        return `${link} — opened a web page instead of a file`;
      } catch (err) {
        return `${link} — ${fetchErrorMessage(err)}`;
      }
    });

    for (const warning of probeResults) {
      if (warning) ctx.warnings.push(warning);
    }
  }

  // 3. Sub-pages of a listing page (one level only).
  //
  //    Only when the page itself produced nothing. A page that already links to
  //    its document is the *answer*, not a folder to crawl — otherwise an
  //    article page whose sidebar points at "recent papers" drags a dozen
  //    unrelated documents into the queue, which is exactly the "it can't get
  //    the exact documents from the link" complaint.
  if (depth === 0 && ctx.documents.length === 0) {
    for (const link of pages.slice(0, ctx.options.maxSubPages)) {
      if (ctx.documents.length >= ctx.options.maxDocs) break;
      if (ctx.seenUrls.has(link)) continue;
      if (!budgetLeft(ctx)) break;
      ctx.seenUrls.add(link);
      try {
        const resource = await fetchResource(link, Math.min(ctx.options.timeoutMs, CANDIDATE_TIMEOUT_MS), pageUrl);
        const sub = detect(resource, link);
        if (sub.kind === 'html') {
          await collectFromPage(resource.finalUrl, resource.buffer, depth + 1, ctx);
        } else if (sub.kind === 'document') {
          // A "page-looking" link that actually serves a file (/pdf/123).
          acceptDocument(resource, resource.finalUrl, ctx);
        }
      } catch {
        /* a broken sub-page must not fail the whole link */
      }
    }
  }
}

/**
 * Resolve one pasted link into local documents.
 * The caller owns the returned temp files.
 */
export async function resolveUrlToDocuments(
  rawUrl: string,
  options: ResolveOptions = {}
): Promise<ResolveOutcome> {
  const opts: Required<ResolveOptions> = { ...DEFAULTS, ...options };

  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: 'Only http:// and https:// links are supported.' };
  }

  const normalized = normalizeShareLink(trimmed);
  if (normalized.unsupported) return { ok: false, error: normalized.unsupported };

  const ctx: CollectContext = {
    options: opts,
    documents: [],
    warnings: [],
    seenUrls: new Set<string>([trimmed, normalized.url]),
    deadline: Date.now() + opts.totalTimeoutMs,
    budgetExhausted: false,
  };

  // ── A Drive folder: list it and download what is inside. ──────────────────
  if (normalized.driveFolderId) {
    try {
      await collectFromDriveFolder(normalized.driveFolderId, 0, ctx);
    } catch (err) {
      return { ok: false, error: fetchErrorMessage(err), warnings: ctx.warnings };
    }

    if (ctx.documents.length === 0) {
      return {
        ok: false,
        error:
          'That Drive folder contains no documents this app can read (PDF, DOCX, PPTX, TXT, MD, HTML).',
        warnings: ctx.warnings,
      };
    }
    return { ok: true, documents: ctx.documents, warnings: ctx.warnings };
  }

  const claimedExt = extFromUrl(trimmed);

  let first: Resource;
  try {
    first = await fetchWithRetry(normalized.url, opts.timeoutMs);
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) };
  }

  const detected = detect(first, first.finalUrl);

  // ── A real file: done. ────────────────────────────────────────────────────
  if (detected.kind === 'document' && detected.ext) {
    const tmpPath = writeTemp(first.buffer, detected.ext);
    return {
      ok: true,
      documents: [
        {
          name: detected.name ?? `document${detected.ext}`,
          tmpPath,
          size: first.buffer.length,
          url: first.finalUrl,
        },
      ],
    };
  }

  // ── Neither a document nor a web page. ────────────────────────────────────
  if (detected.kind !== 'html') {
    return {
      ok: false,
      error: `That link returned ${describe(first)}, which is not a document this app can read.`,
    };
  }

  // ── A web page: look for the documents it links to. ───────────────────────
  await collectFromPage(first.finalUrl, first.buffer, 0, ctx);

  if (ctx.documents.length > 0) {
    return { ok: true, documents: ctx.documents, warnings: ctx.warnings };
  }

  // A URL that promised a file but served a page is a login/preview wall.
  if (claimedExt && claimedExt !== '.html' && claimedExt !== '.htm') {
    return {
      ok: false,
      error:
        `That link opened a web page (${describe(first)}) instead of the file. ` +
        'It is probably behind a sign-in or preview screen — download the file and add it with Browse instead.',
      warnings: ctx.warnings,
    };
  }

  // Otherwise the page itself is the document (an article saved as HTML).
  const tmpPath = writeTemp(first.buffer, '.html');
  return {
    ok: true,
    documents: [
      {
        name: detected.name ?? 'document.html',
        tmpPath,
        size: first.buffer.length,
        url: first.finalUrl,
      },
    ],
    warnings: [
      ...ctx.warnings,
      'That page did not link to any downloadable document, so the page itself was used.',
    ],
  };
}
