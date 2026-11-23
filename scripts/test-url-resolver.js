/**
 * scripts/test-url-resolver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression test for the "Paste Links" resolver (electron/net/resolve.ts).
 *
 * It starts a throwaway HTTP server that reproduces the failure modes seen on
 * real sites — wrong extensions, octet-stream bodies, download endpoints with
 * no filename, meta-declared PDFs, session cookies, sign-in walls, folder pages
 * and hosts that reject browser User-Agents — then asserts what each link
 * resolves to.
 *
 * Run with:  npm run test:url
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { resolveUrlToDocuments, normalizeShareLink, classifyLink, extractLinks, sniffExtension } =
  require(path.join(__dirname, '..', 'dist-electron', 'electron', 'net', 'resolve.js'));

// ── Fixtures ────────────────────────────────────────────────────────────────
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
);

function makeDocx() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello world from a docx</w:t></w:r></w:p></w:body></w:document>')
  );
  return zip.toBuffer();
}
const DOCX = makeDocx();

function makePptx() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile('ppt/presentation.xml', Buffer.from('<?xml version="1.0"?><p:presentation/>'));
  return zip.toBuffer();
}
const PPTX = makePptx();

const routes = {
  '/report.pdf': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  // Name in the query string, octet-stream body.
  '/download?file=report.pdf': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(PDF);
  },
  // No extension, octet-stream, name only in Content-Disposition.
  '/download/42': (res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="annual report.pdf"',
    });
    res.end(PDF);
  },
  // DOCX with no extension anywhere.
  '/file/7': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(DOCX);
  },
  '/listing': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <ul>
        <li><a href="report.pdf">Report (PDF)</a></li>
        <li><a href="/download/42">Annual report</a></li>
        <li><a href="/file/7">Notes</a></li>
        <li><a href="/logo.png">logo</a></li>
      </ul></body></html>`);
  },
  '/listing-base': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><base href="/assets/"></head><body>
      <a href="a.pdf">A</a><a href="b.pdf?x=1&amp;y=2">B</a></body></html>`);
  },
  '/assets/a.pdf': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  '/assets/b.pdf?x=1&y=2': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  '/no-docs': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Welcome</h1><p>Nothing here.</p><a href="/about">About</a></body></html>');
  },
  // A URL that promises a PDF but serves a login page.
  '/login.pdf': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><form>Please sign in to continue</form></body></html>');
  },
  // Listing page mislabelled as text/plain.
  '/mislabelled': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('<html><body><a href="/report.pdf">Report</a></body></html>');
  },
  // Folder page -> sub-page -> documents.
  '/folder': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><a href="/folder/week1">Week 1</a></body></html>');
  },
  '/folder/week1': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><a href="/report.pdf">Slides</a></body></html>');
  },
  // A link that looks like a page but serves the file directly (/pdf/123).
  '/pdf-page': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><a href="/pdf/123">Read the paper</a></body></html>');
  },
  '/pdf/123': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  '/empty': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(Buffer.alloc(0));
  },
  '/missing': (res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('not found');
  },
  // A portal that hands out a session cookie on the listing page and requires
  // it (plus a matching Referer) for the download.
  '/session/listing': (res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'SESSID=abc123; Path=/; HttpOnly',
    });
    res.end('<html><body><a href="/session/file">Download</a></body></html>');
  },
  '/session/file': (res, req) => {
    const cookie = req.headers.cookie ?? '';
    if (!/SESSID=abc123/.test(cookie)) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  // A document that only answers when the request carries a Referer.
  '/referer-listing': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><a href="/referer-guarded.pdf">Guarded</a></body></html>');
  },
  '/referer-guarded.pdf': (res, req) => {
    if (!req.headers.referer) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('no referer');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  // A meta-refresh redirect to the real file.
  '/meta-refresh': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta http-equiv="refresh" content="0; url=/report.pdf"></head><body></body></html>');
  },
  // An abstract page that only declares its PDF in metadata (arXiv style),
  // surrounded by unrelated site chrome from another origin.
  '/abstract': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head>
      <meta name="citation_title" content="Attention Is All You Need">
      <meta name="citation_pdf_url" content="/paper.pdf">
      </head><body>
      <a href="https://info.example.com/help/donate.html">Donate</a>
      <a href="https://info.example.com/help/trackback.html">Trackback</a>
      <a href="/list/recent">Recent</a>
      <p>Abstract text…</p></body></html>`);
  },
  '/paper.pdf': (res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
  // A page that declares its PDF with <link rel="alternate">.
  '/link-alt': (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><link rel="alternate" type="application/pdf" href="/paper.pdf"></head><body>Paper</body></html>');
  },
  // A host that rejects browser User-Agents (w3.org does exactly this).
  '/strict-ua.pdf': (res, req) => {
    if (/mozilla/i.test(req.headers['user-agent'] ?? '')) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('go away');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(PDF);
  },
};

// ── Google Drive fixtures ────────────────────────────────────────────────────
// The resolver talks to drive.google.com and docs.google.com, which a test
// server cannot impersonate. Instead `fetch` is wrapped once for the Drive
// tests: Drive URLs are redirected to equivalent local routes, so the real
// code path (listing parser, export URLs, interstitial form) is still what
// runs.

/** embeddedfolderview markup for a public folder: 2 files, 1 Doc, 1 folder, 1 photo. */
const FOLDER_LISTING = `<!DOCTYPE html><html><head><title>Folder</title></head><body>
<div class="flip-entry" id="entry-FILEID_PDF_0000000001" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://drive.google.com/file/d/FILEID_PDF_0000000001/view?usp=drive_web"></a>
    <div class="flip-entry-title">Lecture 1 - Intro.pdf</div>
    <div class="flip-entry-last-modified">Yesterday</div>
  </div>
</div>
<div class="flip-entry" id="entry-FILEID_PPT_0000000002" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://drive.google.com/file/d/FILEID_PPT_0000000002/view?usp=drive_web"></a>
    <div class="flip-entry-title">Week 2 slides.pptx</div>
  </div>
</div>
<div class="flip-entry" id="entry-DOCID_00000000000000003" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://docs.google.com/document/d/DOCID_00000000000000003/edit?usp=drive_web"></a>
    <div class="flip-entry-title">Course notes</div>
  </div>
</div>
<div class="flip-entry" id="entry-SUBFOLDER_000000000004" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://drive.google.com/drive/folders/SUBFOLDER_000000000004"></a>
    <div class="flip-entry-title">Week 3</div>
  </div>
</div>
<div class="flip-entry" id="entry-PHOTO_00000000000005" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://drive.google.com/file/d/PHOTO_00000000000005/view?usp=drive_web"></a>
    <div class="flip-entry-title">whiteboard.jpg</div>
  </div>
</div>
</body></html>`;

/** A sub-folder with one PDF inside it. */
const SUBFOLDER_LISTING = `<html><body>
<div class="flip-entry" id="entry-FILEID_DEEP_0000000006" tabindex="0">
  <div class="flip-entry-info">
    <a class="flip-entry-open" href="https://drive.google.com/file/d/FILEID_DEEP_0000000006/view"></a>
    <div class="flip-entry-title">Week 3 - Algorithms.pdf</div>
  </div>
</div>
</body></html>`;

/** Drive's "can't scan this file for viruses" page, as it is really shaped. */
const CONFIRM_PAGE = `<!DOCTYPE html><html><body>
<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
  <input type="hidden" name="id" value="FILEID_BIG_00000000000007">
  <input type="hidden" name="export" value="download">
  <input type="hidden" name="confirm" value="t">
  <input type="hidden" name="uuid" value="0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0">
  <input type="submit" value="Download anyway">
</form></body></html>`;

routes['/drive/folders/ROOTFOLDER_000000000001'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(FOLDER_LISTING);
};
routes['/drive/folders/SUBFOLDER_000000000004'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(SUBFOLDER_LISTING);
};
routes['/drive/folders/PRIVATEFOLDER_0000000002'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><body><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>');
};
routes['/drive/folders/EMPTYFOLDER_00000000003'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><body><div class="flip-footer">Empty folder</div></body></html>');
};
routes['/drive/file/FILEID_PDF_0000000001'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf' });
  res.end(PDF);
};
routes['/drive/file/FILEID_PPT_0000000002'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(PPTX);
};
routes['/drive/file/FILEID_DEEP_0000000006'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf' });
  res.end(PDF);
};
routes['/drive/docs/DOCID_00000000000000003'] = (res) => {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  res.end(DOCX);
};
routes['/drive/file/FILEID_BIG_00000000000007'] = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(CONFIRM_PAGE);
};
routes['/drive/confirmed'] = (res, req) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.searchParams.get('confirm') !== 't' || !url.searchParams.get('uuid')) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('missing confirm fields');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/pdf' });
  res.end(PDF);
};

const server = http.createServer((req, res) => {
  // Exact match first (some fixtures key on the query string), then by path.
  const handler = routes[req.url] ?? routes[req.url.split('?')[0]];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('no route ' + req.url);
    return;
  }
  handler(res, req);
});

/** Send Google hosts to the local equivalents, keep everything else real. */
function installDriveStub(base) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    let mapped = null;

    if (raw.startsWith('https://drive.google.com/embeddedfolderview')) {
      const id = new URL(raw).searchParams.get('id');
      mapped = `${base}/drive/folders/${id}`;
    } else if (raw.startsWith('https://drive.google.com/uc?')) {
      const id = new URL(raw).searchParams.get('id');
      mapped = `${base}/drive/file/${id}`;
    } else if (raw.startsWith('https://docs.google.com/document/d/')) {
      mapped = `${base}/drive/docs/${new URL(raw).pathname.split('/')[3]}`;
    } else if (raw.startsWith('https://drive.usercontent.google.com/download')) {
      const params = new URL(raw).searchParams;
      mapped = `${base}/drive/confirmed?confirm=${params.get('confirm')}&uuid=${params.get('uuid')}`;
    }

    return realFetch(mapped ?? raw, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function run() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function expectDocs(path, count, label, opts) {
    const out = await resolveUrlToDocuments(base + path, opts);
    const docs = out.documents ?? [];
    check(
      label,
      out.ok && docs.length === count,
      out.ok ? docs.map((d) => `${d.name}(${d.size}b)`).join(', ') : out.error
    );
    for (const d of docs) {
      if (fs.existsSync(d.tmpPath)) fs.unlinkSync(d.tmpPath);
    }
    return out;
  }

  await expectDocs('/report.pdf', 1, 'direct PDF link');
  await expectDocs('/download?file=report.pdf', 1, 'PDF named only in query string');
  await expectDocs('/download/42', 1, 'octet-stream + Content-Disposition name');
  await expectDocs('/file/7', 1, 'extension-less DOCX');
  await expectDocs('/listing', 3, 'listing page: 2 direct + 1 extension-less');
  await expectDocs('/listing-base', 2, 'listing page honours <base href>');
  await expectDocs('/mislabelled', 1, 'listing mislabelled as text/plain');
  await expectDocs('/folder', 1, 'folder page → sub-page → document');
  await expectDocs('/pdf-page', 1, 'link that looks like a page but serves a PDF');
  await expectDocs('/session/listing', 1, 'session cookie from the page is reused for the download');
  await expectDocs('/referer-listing', 1, 'Referer is sent for documents found on a page');
  await expectDocs('/meta-refresh', 1, 'meta-refresh redirect to the real file');
  await expectDocs('/abstract', 1, 'PDF declared in <meta citation_pdf_url>');
  await expectDocs('/link-alt', 1, 'PDF declared in <link rel=alternate>');
  await expectDocs('/strict-ua.pdf', 1, 'host that rejects browser User-Agents still serves the file');

  // A page with no documents must still be usable, with a warning.
  const noDocs = await expectDocs('/no-docs', 1, 'page with no document links falls back to the page');
  check(
    'page fallback explains itself',
    (noDocs.warnings ?? []).some((w) => /page itself was used/i.test(w)),
    (noDocs.warnings ?? [])[0]
  );

  // A login wall must be reported, not saved as a bogus PDF.
  const login = await resolveUrlToDocuments(base + '/login.pdf');
  check(
    'login wall is reported clearly',
    !login.ok && /web page/i.test(login.error ?? ''),
    login.error
  );

  const empty = await resolveUrlToDocuments(base + '/empty');
  check('empty response is reported', !empty.ok, empty.error);

  const missing = await resolveUrlToDocuments(base + '/missing');
  check('404 is reported', !missing.ok && /no longer exists|404/i.test(missing.error ?? ''), missing.error);

  const badScheme = await resolveUrlToDocuments('ftp://example.com/x.pdf');
  check('non-http link rejected', !badScheme.ok, badScheme.error);

  // ── Google Drive folder (fetch redirected to local fixtures) ──────────────
  const restoreFetch = installDriveStub(base);
  try {
    const folderOut = await resolveUrlToDocuments(
      'https://drive.google.com/drive/folders/ROOTFOLDER_000000000001'
    );
    const names = (folderOut.documents ?? []).map((d) => d.name).sort();
    check(
      'Drive folder → every document inside it',
      folderOut.ok && names.length === 4,
      names.join(', ') || folderOut.error
    );
    check(
      'Drive folder → native Google Doc exported as .docx',
      names.includes('Course notes.docx'),
      names.join(', ')
    );
    check(
      'Drive folder → photo skipped, sub-folder followed',
      names.includes('Week 3 - Algorithms.pdf'),
      names.join(', ')
    );
    check(
      'Drive folder → skip summary is explained',
      (folderOut.warnings ?? []).some((w) => /not a document format/i.test(w)),
      (folderOut.warnings ?? [])[0]
    );
    for (const d of folderOut.documents ?? []) {
      if (fs.existsSync(d.tmpPath)) fs.unlinkSync(d.tmpPath);
    }

    const privateOut = await resolveUrlToDocuments(
      'https://drive.google.com/drive/folders/PRIVATEFOLDER_0000000002'
    );
    check(
      'private Drive folder → says it is not shared publicly',
      !privateOut.ok && /not shared publicly|Anyone with the link/i.test(privateOut.error ?? ''),
      privateOut.error
    );

    const emptyOut = await resolveUrlToDocuments(
      'https://drive.google.com/drive/folders/EMPTYFOLDER_00000000003'
    );
    check(
      'empty Drive folder → readable error',
      !emptyOut.ok && /empty|no documents/i.test(emptyOut.error ?? ''),
      emptyOut.error
    );

    const bigOut = await resolveUrlToDocuments('https://drive.google.com/file/d/FILEID_BIG_00000000000007/view');
    check(
      'Drive virus-scan interstitial → form fields submitted, file obtained',
      bigOut.ok && (bigOut.documents ?? []).length === 1,
      bigOut.ok ? bigOut.documents[0].name : bigOut.error
    );
    for (const d of bigOut.documents ?? []) {
      if (fs.existsSync(d.tmpPath)) fs.unlinkSync(d.tmpPath);
    }
  } finally {
    restoreFetch();
  }

  // ── Pure helpers ──────────────────────────────────────────────────────────
  const drive = normalizeShareLink('https://drive.google.com/file/d/ABC123xyz/view?usp=sharing');
  check(
    'Google Drive file link → direct download',
    drive.url === 'https://drive.google.com/uc?export=download&id=ABC123xyz',
    drive.url
  );

  const gdoc = normalizeShareLink('https://docs.google.com/document/d/DOC1/edit');
  check('Google Docs link → docx export', /\/document\/d\/DOC1\/export\?format=docx$/.test(gdoc.url), gdoc.url);

  const gslides = normalizeShareLink('https://docs.google.com/presentation/d/SL1/edit#slide=id');
  check('Google Slides link → pptx export', /\/presentation\/d\/SL1\/export\/pptx$/.test(gslides.url), gslides.url);

  const folder = normalizeShareLink('https://drive.google.com/drive/folders/F1');
  check(
    'Google Drive folder link → folder listing (not an error)',
    folder.driveFolderId === 'F1',
    folder.driveFolderId ?? folder.unsupported
  );

  check(
    'Google Drive folder link with /u/0/ and ?usp=sharing',
    normalizeShareLink('https://drive.google.com/drive/u/0/folders/ABCdef123?usp=sharing')
      .driveFolderId === 'ABCdef123'
  );

  check(
    'Google Drive open?id= link → direct download',
    /uc\?export=download&id=XYZ789$/.test(
      normalizeShareLink('https://drive.google.com/open?id=XYZ789').url
    )
  );

  check(
    'drive.usercontent.google.com download link → direct download',
    /uc\?export=download&id=XYZ789$/.test(
      normalizeShareLink('https://drive.usercontent.google.com/download?id=XYZ789&export=download')
        .url
    )
  );

  check(
    'Google Sheets link → PDF export (readable format)',
    /\/spreadsheets\/d\/SHEET1\/export\?format=pdf$/.test(
      normalizeShareLink('https://docs.google.com/spreadsheets/d/SHEET1/edit').url
    )
  );

  check(
    'Google Drive home page → actionable error',
    Boolean(normalizeShareLink('https://drive.google.com/drive/my-drive').unsupported)
  );

  const dropbox = normalizeShareLink('https://www.dropbox.com/scl/fi/x/report.pdf?dl=0');
  check('Dropbox link → dl=1', /dl=1/.test(dropbox.url), dropbox.url);

  check(
    'classify: /download/42 is a candidate',
    classifyLink(base + '/download/42', base + '/listing') === 'candidate'
  );
  check('classify: report.pdf is a document', classifyLink(base + '/report.pdf', base) === 'document');
  check(
    'classify: /pdf/1706.03762 is a candidate, not skipped for its fake extension',
    classifyLink('https://arxiv.org/pdf/1706.03762', 'https://arxiv.org/abs/1706.03762') === 'candidate'
  );
  check('classify: logo.png is skipped', classifyLink(base + '/logo.png', base) === 'skip');
  check('classify: /about is skipped as site chrome', classifyLink(base + '/about', base) === 'skip');
  check('classify: /folder/week1 is a page', classifyLink(base + '/folder/week1', base) === 'page');
  check(
    'classify: same-origin .html is a page, not a document',
    classifyLink(base + '/docs/index.html', base) === 'page'
  );
  check(
    'classify: off-origin .html is skipped',
    classifyLink('https://info.example.com/help/donate.html', base) === 'skip'
  );
  check(
    'classify: off-site plain page is skipped',
    classifyLink('https://other.example.com/thing', base) === 'skip'
  );

  const links = extractLinks(
    '<a href="x.pdf">x</a><iframe src="y.pdf"></iframe><object data="z.pdf"></object><a href="mailto:a@b.c">m</a>',
    base + '/p'
  );
  check('extractLinks finds anchors, iframes and objects', links.length === 3, links.join(' '));

  const declaredLinks = extractLinks(
    '<html><head><meta name="citation_pdf_url" content="/paper.pdf">' +
      '<link rel="alternate" type="application/pdf" href="/alt.pdf"></head>' +
      '<body><a href="/other.pdf">other</a></body></html>',
    base + '/abs'
  );
  check(
    'declared PDFs come before page links',
    declaredLinks[0] === base + '/paper.pdf' && declaredLinks[1] === base + '/alt.pdf',
    declaredLinks.join(' ')
  );

  check('sniff: PDF magic bytes', sniffExtension(PDF, 'application/octet-stream') === '.pdf');
  check('sniff: DOCX zip parts', sniffExtension(DOCX, 'application/octet-stream') === '.docx');
  check(
    'sniff: html despite .pdf URL',
    sniffExtension(Buffer.from('<!doctype html><html></html>'), 'text/html', 'https://x/y.pdf') === '.html'
  );

  server.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exitCode = 1;
  server.close();
});
