/**
 * scripts/test-export.js
 * -----------------------------------------------------------------------------
 * Regression test for the export stage (PPTX + standalone HTML).
 *
 * The export code lives in the renderer, so it is bundled here with esbuild and
 * run in Node against a real deck from the generator. This catches the failures
 * that a build cannot: a deck whose slide count does not match the package, a
 * PPTX that is not a valid zip, and an HTML file that is not self-contained.
 *
 * Run with:  npm run test:export
 */
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
// Inside the project so the bundled code resolves pptxgenjs from node_modules.
const outDir = path.join(root, 'node_modules', '.cache', 'doc-to-slides-export-test');

async function bundle(name) {
  const { build } = require('esbuild');
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `${name}.cjs`);
  await build({
    entryPoints: [path.join(root, 'src', 'export', `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // pptxgenjs is resolved from node_modules at run time.
    external: ['pptxgenjs'],
    logLevel: 'silent',
  });
  return require(outfile);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

(async () => {
  const { exportPptx } = await bundle('pptx');
  const { exportHtml } = await bundle('html');
  const { mergeOutlines } = require(
    path.join(root, 'dist-electron', 'electron', 'summarizer', 'merge.js')
  );
  const { generateSlides } = require(
    path.join(root, 'dist-electron', 'electron', 'slides', 'generator.js')
  );

  const sentences = [
    'Algoritma pemrograman adalah urutan langkah logis untuk menyelesaikan masalah.',
    'Setiap algoritma memiliki masukan, proses, dan keluaran yang jelas.',
    'Struktur data menentukan cara penyimpanan agar akses menjadi efisien.',
    'Bahasa pemrograman menerjemahkan logika manusia menjadi instruksi mesin.',
    'Compiler memeriksa keseluruhan kode sebelum program dijalankan.',
    'Interpreter menjalankan kode baris demi baris saat program berjalan.',
    'Debugger membantu menemukan kesalahan logika pada program.',
    'Paradigma prosedural menyusun program sebagai rangkaian prosedur.',
    'Paradigma berorientasi objek membungkus data bersama perilakunya.',
    'Paradigma fungsional memperlakukan perhitungan sebagai fungsi murni.',
    'Pengujian unit memastikan setiap bagian program bekerja sesuai harapan.',
    'Dokumentasi yang baik mempercepat pemeliharaan perangkat lunak.',
  ].join(' ');

  const deck = generateSlides(
    mergeOutlines([sentences, sentences.replace(/algoritma/gi, 'basis data')]),
    ['Algoritma Pemrograman', 'Basis Data']
  );
  check('a deck is generated', deck.length >= 4, `${deck.length} slides`);

  // ---- PPTX -----------------------------------------------------------------
  const pptxBytes = await exportPptx(deck);
  const pptx = Buffer.from(pptxBytes);
  check('PPTX is not empty', pptx.length > 10_000, `${pptx.length} bytes`);
  check('PPTX is a zip archive', pptx.slice(0, 2).toString('latin1') === 'PK');

  const latin = pptx.toString('latin1');
  const slideParts = [
    ...new Set([...latin.matchAll(/ppt\/slides\/slide(\d+)\.xml/g)].map((m) => Number(m[1]))),
  ];
  check(
    'PPTX contains one slide part per slide',
    slideParts.length === deck.length,
    `${slideParts.length} parts / ${deck.length} slides`
  );
  check(
    'PPTX slide parts are numbered without gaps',
    slideParts.sort((a, b) => a - b).every((n, i) => n === i + 1),
    slideParts.join(',')
  );

  // ---- HTML -----------------------------------------------------------------
  const html = exportHtml(deck);
  check('HTML is self-contained', !/(src|href)\s*=\s*["']https?:/i.test(html));
  check('HTML is a complete document', /^<!DOCTYPE html>/i.test(html) && /<\/html>\s*$/i.test(html));

  // The deck travels inside a <script> block as JSON; pull it back out and
  // confirm nothing was lost on the way.
  const embedded = html.match(/var slides=(\[.*?\]);\n/s);
  check('HTML embeds the deck as data', Boolean(embedded));

  let parsed = [];
  try {
    parsed = JSON.parse(embedded[1]);
    check('embedded deck is valid JSON', true);
  } catch (err) {
    check('embedded deck is valid JSON', false, err.message);
  }
  if (parsed.length > 0) {
    check(
      'embedded deck has every slide',
      parsed.length === deck.length,
      `${parsed.length} / ${deck.length}`
    );
    check(
      'embedded deck keeps every bullet',
      parsed.every((s, i) => s.bullets.length === deck[i].bullets.length),
      parsed.map((s) => s.bullets.length).join(',')
    );
    check('embedded deck keeps the titles', parsed.every((s, i) => s.title === deck[i].title));
  }

  // A document may legitimately contain "</script>"; it must not end the block.
  const hostile = [{ ...deck[0], title: 'Closing tags </script> in text', bullets: ['a </script> b'] }];
  const hostileHtml = exportHtml(hostile);
  const scriptBlocks = (hostileHtml.match(/<\/script>/gi) ?? []).length;
  check(
    'a "</script>" in a document cannot break the file',
    scriptBlocks === 1,
    `${scriptBlocks} closing tags`
  );
  check('a "</script>" survives as text', hostileHtml.includes('a \\u003c/script> b'));

  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* left behind, harmless */
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('export test crashed:', err);
  process.exitCode = 1;
});
