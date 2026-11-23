/**
 * scripts/test-deck-quality.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression test for the outline → deck stage.
 *
 * These are the failures that are easy to reintroduce and invisible in a build:
 *
 *   • the deck did not grow with the number of documents (five documents
 *     produced six slides, one per document)
 *   • slide titles were sentence fragments ("Ketika Pengguna",
 *     "Struktur Ini Memungkinkan Kita", "…, Mulai")
 *   • a deck lost its cover or its closing slide
 *
 * Run with:  npm run test:deck
 */
const path = require('path');

const { mergeOutlines, outlineGroups } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'summarizer', 'merge.js')
);
const { generateSlides } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'slides', 'generator.js')
);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Independent copies of the rules, so the test is not the implementation. */
const BAD_START = new Set([
  'ketika', 'jika', 'saat', 'setelah', 'sebelum', 'karena', 'untuk', 'dengan',
  'dalam', 'pada', 'di', 'dari', 'bagi', 'sebagai', 'yang', 'dan', 'atau',
  'tetapi', 'namun', 'telah', 'sudah', 'akan', 'masih', 'juga', 'hanya',
  'when', 'if', 'because', 'after', 'before', 'while', 'to', 'for', 'in', 'on',
  'at', 'by', 'from', 'with', 'that', 'which', 'and', 'or', 'but',
]);
const BAD_END = new Set([
  'kita', 'kami', 'mereka', 'ini', 'itu', 'tersebut', 'bersama', 'mulai',
  'apakah', 'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'dalam', 'pada',
  'untuk', 'dengan', 'sebagai', 'oleh', 'adalah', 'telah', 'akan', 'dapat',
  'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'that',
  'which', 'is', 'are', 'was', 'were', 'has', 'have', 'been', 'both', 'all',
]);

/**
 * A bullet is a full clause, so a pronoun or determiner may end it
 * ("... memungkinkan kita", "... materi ini"). Only words that need a
 * following phrase are true danglers there.
 */
const BULLET_BAD_END = new Set([
  'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'dalam', 'pada', 'untuk',
  'dengan', 'sebagai', 'oleh', 'adalah', 'the', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'and', 'or', 'that', 'which', 'is', 'are', 'was', 'were',
  'has', 'have', 'been', 'both', 'all', 'each', 'such', 'than',
]);

const clean = (w) => w.toLowerCase().replace(/[^a-z\u00C0-\u024F'-]/g, '');

function titleProblems(slides) {
  const problems = [];
  for (const slide of slides) {
    const words = slide.title.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      problems.push(`"${slide.title}" — empty`);
      continue;
    }
    if (BAD_START.has(clean(words[0]))) problems.push(`"${slide.title}" — starts with ${words[0]}`);
    const last = clean(words[words.length - 1]);
    if (BAD_END.has(last)) problems.push(`"${slide.title}" — ends with ${last}`);
  }
  return problems;
}

/** A document whose summary is `n` ordinary sentences on one topic. */
function summaryFor(topic, n) {
  const shapes = [
    `${topic} menjadi dasar utama dalam pembahasan materi ini`,
    `Pembahasan ${topic} mencakup konsep dasar dan penerapannya`,
    `Setiap bagian dari ${topic} memiliki fungsi yang saling melengkapi`,
    `Pemahaman terhadap ${topic} membantu menyelesaikan masalah nyata`,
    `${topic} berkembang seiring dengan kebutuhan penggunanya`,
    `Contoh penerapan ${topic} dapat ditemukan di banyak bidang`,
    `Kesalahan umum pada ${topic} berasal dari asumsi yang keliru`,
    `Latihan rutin membuat penguasaan ${topic} meningkat`,
    `Evaluasi terhadap ${topic} dilakukan secara berkala`,
    `Dokumentasi ${topic} disusun agar mudah dipelajari`,
    `Kolaborasi mempercepat pematangan konsep ${topic}`,
    `Perkembangan ${topic} dipengaruhi oleh riset terbaru`,
  ];
  return shapes.slice(0, n).map((s) => `${s}.`).join(' ');
}

// ── Deck size scales with the number of documents ────────────────────────────

const one = mergeOutlines([summaryFor('Algoritma Pemrograman', 12)]);
const five = mergeOutlines([
  summaryFor('Algoritma Pemrograman', 12),
  summaryFor('Basis Data Relasional', 12),
  summaryFor('Jaringan Komputer', 12),
  summaryFor('Sistem Operasi', 12),
  summaryFor('Rekayasa Perangkat Lunak', 12),
]);

const oneDeck = generateSlides(one, ['Satu Dokumen']);
const fiveDeck = generateSlides(five, ['A', 'B', 'C', 'D', 'E']);

check(
  'a single document still gets a full deck',
  oneDeck.length >= 4 && oneDeck.length <= 8,
  `${oneDeck.length} slides`
);
check(
  'five documents get a bigger deck than one',
  fiveDeck.length > oneDeck.length,
  `${oneDeck.length} → ${fiveDeck.length} slides`
);
check(
  'five documents do not collapse to one slide each',
  fiveDeck.length >= 9,
  `${fiveDeck.length} slides`
);

// ── Deck shape ───────────────────────────────────────────────────────────────

check(
  'deck opens with a cover slide',
  fiveDeck[0]?.type === 'title',
  fiveDeck[0]?.title
);
check(
  'deck closes with Key Takeaways',
  fiveDeck[fiveDeck.length - 1]?.type === 'conclusion' &&
    /takeaway/i.test(fiveDeck[fiveDeck.length - 1].title),
  fiveDeck[fiveDeck.length - 1]?.title
);
check(
  'every content slide has 2–5 bullets',
  fiveDeck
    .filter((s) => s.type === 'content')
    .every((s) => s.bullets.length >= 2 && s.bullets.length <= 5),
  fiveDeck
    .filter((s) => s.type === 'content')
    .map((s) => s.bullets.length)
    .join(',')
);

// ── Titles are topics, not fragments ─────────────────────────────────────────

const problems = titleProblems(fiveDeck);
check('no title is a sentence fragment', problems.length === 0, problems.join(' | '));

// Sentences that specifically used to produce fragments.
const fragmentSource =
  'Ketika pengguna memberikan pertanyaan maka program akan menjalankan aturan. ' +
  'Struktur ini memungkinkan kita menyusun program dengan rapi. ' +
  'Di PJJ S1 Teknologi Informasi, kuliah ini bersama. ' +
  'Telah dijelaskan pada sesi sebelumnya bahwa abstraksi adalah fokus utama. ' +
  'Lingkungan berupa aplikasi berbasis web tempat mengeksekusi program, mulai.';
const fragmentDeck = generateSlides(fragmentSource, []);
const fragmentProblems = titleProblems(fragmentDeck);
check(
  'fragment-prone sentences still yield real titles',
  fragmentProblems.length === 0,
  fragmentProblems.join(' | ') || fragmentDeck.map((s) => s.title).join(' / ')
);

// ── Bullets ──────────────────────────────────────────────────────────────────

const allBullets = fiveDeck.flatMap((s) => s.bullets);
check(
  'bullets do not end on a dangling word',
  allBullets.every((b) => {
    const words = b.split(/\s+/).filter(Boolean);
    return !BULLET_BAD_END.has(clean(words[words.length - 1] ?? ''));
  }),
  allBullets.find((b) => {
    const w = b.split(/\s+/).filter(Boolean);
    return BULLET_BAD_END.has(clean(w[w.length - 1] ?? ''));
  }) ?? ''
);
check(
  'bullets do not end with a full stop',
  allBullets.every((b) => !/[.]$/.test(b)),
  allBullets.find((b) => /[.]$/.test(b)) ?? ''
);
check(
  'bullets carry no citation markers',
  allBullets.every((b) => !/\[\d/.test(b)),
  allBullets.find((b) => /\[\d/.test(b)) ?? ''
);
check(
  'parentheses are balanced in titles and bullets',
  [...fiveDeck.map((s) => s.title), ...allBullets].every(
    (t) => (t.match(/\(/g) ?? []).length === (t.match(/\)/g) ?? []).length
  )
);

// ── No stutter ───────────────────────────────────────────────────────────────
const stutterDeck = generateSlides(
  'Deskripsi Mata Kuliah Mata Kuliah ini bertujuan menjelaskan ruang lingkup. ' +
    'Bahan kajian Bahan Kajian disusun berdasarkan capaian pembelajaran.',
  []
);
const stutters = stutterDeck
  .map((s) => s.title)
  .filter((t) => {
    const w = t.split(/\s+/).filter(Boolean).map((x) => x.toLowerCase());
    for (let size = 1; size <= 3; size++) {
      for (let i = 0; i + size * 2 <= w.length; i++) {
        if (w.slice(i, i + size).join(' ') === w.slice(i + size, i + size * 2).join(' ')) return true;
      }
    }
    return false;
  });
check(
  'titles do not repeat a phrase',
  stutters.length === 0,
  stutters.join(' | ') || stutterDeck.map((s) => s.title).join(' / ')
);

// A title must not stop on a word that needs what follows it.
const modalDeck = generateSlides(
  'Mahasiswa mampu menggunakan berbagai perangkat AI secara bertanggung jawab. ' +
    'Mahasiswa mampu menjelaskan klasifikasi utama algoritma AI dengan tepat.',
  []
);
check(
  'titles never end on a modal',
  modalDeck.every((s) => !/\b(mampu|boleh|harus|wajib|ingin|hendak)$/i.test(s.title)),
  modalDeck.map((s) => s.title).join(' / ')
);

// ── One document per slide ───────────────────────────────────────────────────
// Grouped input must keep each slide inside a single source document, so a
// slide titled after one topic never carries a bullet from another file.
const docA = [
  'Back propagation menghitung kesalahan antara prediksi dan label asli.',
  'Kesalahan tersebut dikirim kembali untuk memperbarui bobot jaringan.',
  'Bobot diperbarui secara bertahap hingga galat menjadi kecil.',
  'Proses ini membuat jaringan belajar dari contoh yang diberikan.',
  'Laju pembelajaran menentukan besar langkah pembaruan bobot.',
  'Arsitektur jaringan menentukan jumlah lapisan yang dipakai.',
  'Fungsi aktivasi menambahkan sifat tidak linear pada keluaran neuron.',
].join(' ');
const docB = [
  'Materi fisika sering dianggap sulit oleh sebagian siswa.',
  'Pemahaman konsep gerak dan gaya menjadi fokus penelitian ini.',
  'Subjek penelitian berjumlah lima puluh tiga mahasiswa.',
  'Pembelajaran dilakukan tatap muka dengan jam yang terbatas.',
  'Kesalahan konsep paling banyak terjadi pada analisis massa.',
  'Arah gaya berat sering dipahami secara keliru oleh siswa.',
].join(' ');

const grouped = outlineGroups([docA, docB]);
check(
  'each document becomes its own group',
  grouped.length === 2,
  `${grouped.length} groups`
);

const groupedDeck = generateSlides(grouped, ['Jaringan Saraf', 'Fisika Dasar']);
const physicsWords = /fisika|siswa|gaya|massa|mahasiswa/i;
const neuralWords = /bobot|jaringan|galat|prediksi|lapisan/i;

const bleed = groupedDeck
  .filter((s) => s.type === 'content')
  .filter((s) => {
    const text = `${s.title} ${s.bullets.join(' ')}`;
    return physicsWords.test(text) && neuralWords.test(text);
  })
  .map((s) => s.title);
check('no slide mixes two documents', bleed.length === 0, bleed.join(' | '));

// A document must not be split around another one: its slides stay together.
const contentText = groupedDeck
  .filter((s) => s.type === 'content')
  .map((s) => `${s.title} ${s.bullets.join(' ')}`);
const lastNeural = contentText.map((t) => neuralWords.test(t)).lastIndexOf(true);
const firstPhysics = contentText.map((t) => physicsWords.test(t)).indexOf(true);
check(
  'documents keep their order',
  firstPhysics === -1 || lastNeural === -1 || lastNeural < firstPhysics,
  `last neural ${lastNeural}, first physics ${firstPhysics}`
);
check(
  'grouped input still produces a full deck',
  groupedDeck.length >= 4 && groupedDeck.length <= 12,
  `${groupedDeck.length} slides`
);
check(
  'a grouped deck keeps 2–5 bullets per content slide',
  groupedDeck
    .filter((s) => s.type === 'content')
    .every((s) => s.bullets.length >= 2 && s.bullets.length <= 5),
  groupedDeck.filter((s) => s.type === 'content').map((s) => s.bullets.length).join(',')
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
