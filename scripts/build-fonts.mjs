/**
 * Regenerates packages/integrations/src/pdf/fonts.ts.
 *
 * The invoice and the receipt are rendered by pdfkit, which embeds whatever
 * font it is handed. This script builds that font.
 *
 * Why this font, and why a merge
 * ------------------------------
 * The fonts used to be DejaVu Sans, which carries no Devanagari at all, so a
 * member whose name is written in Marathi or Hindi got a receipt of hollow
 * boxes. The code said the cause was that "pdfkit cannot shape complex
 * scripts". That turned out to be untrue: pdfkit 0.20 lays text out through
 * fontkit 2, which runs the Indic shaper, and given a font with the glyphs it
 * renders Devanagari correctly — reph, matras, conjuncts and all. The problem
 * was never shaping. It was coverage.
 *
 * So the font is Noto Sans Devanagari, which covers Latin, Devanagari and the
 * rupee sign in one design. Google ships it split into per-script subsets, so
 * the Latin and Devanagari halves are merged back into one file here. Merging
 * two subsets of the SAME source font is safe in a way that merging two
 * different typefaces is not: identical design, identical metrics, and layout
 * tables that were built together.
 *
 * One font rather than two, deliberately: the alternative is to split every
 * string into script runs and switch fonts mid-line, across fifty-odd text
 * calls in two renderers, each with its own wrapping and alignment. One font
 * that covers both scripts needs no call site to know anything.
 *
 * The result is gzipped before base64, because the merged font is 169 KB a
 * weight where the old Latin-only subset was 15 KB. Gzip takes the pair from
 * 338 KB to 131 KB, and `gunzipSync` at startup costs about a millisecond.
 *
 * Needs: fonttools with brotli (`pip install fonttools brotli`) and the npm
 * package @fontsource/noto-sans-devanagari. The generated file is committed,
 * so a normal build and a normal deploy never run this.
 *
 *   node scripts/build-fonts.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WEIGHTS = { regular: 400, bold: 700 };

// Printable ASCII, the typographic marks the documents use, the rupee sign,
// and the whole Devanagari block. ZWJ and ZWNJ are in because they are how a
// writer forces or forbids a conjunct, and dropping them silently changes
// spelling.
const UNICODES = [
  '0020-007E',
  '00A0', '00B7',
  '2013', '2014', '2018', '2019', '201C', '201D', '2022', '2026',
  // U+2212 MINUS SIGN, not the ASCII hyphen: the invoice prints it on the
  // discount and payment rows. It was missing from the old subset, so every
  // invoice that recorded a payment printed a hollow box next to the amount.
  '2212',
  '20B9',
  '200C', '200D',
  '0900-097F',
].join(',');

const work = mkdtempSync(join(tmpdir(), 'gym-fonts-'));

function fontsourceFile(subset, weight) {
  const path = join(
    'node_modules/@fontsource/noto-sans-devanagari/files',
    `noto-sans-devanagari-${subset}-${weight}-normal.woff2`,
  );
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}.\nInstall it first: pnpm add -Dw @fontsource/noto-sans-devanagari`,
    );
  }
  return path;
}

const python = (source) => execFileSync('python3', ['-c', source], { encoding: 'utf8' });

const encoded = {};

for (const [name, weight] of Object.entries(WEIGHTS)) {
  const latin = fontsourceFile('latin', weight);
  const devanagari = fontsourceFile('devanagari', weight);
  const merged = join(work, `merged-${weight}.ttf`);
  const subsetted = join(work, `subset-${weight}.ttf`);

  // woff2 -> ttf, merge, subset, in one pass so the intermediates stay in
  // the temp directory and never near the repository.
  python(`
from fontTools.ttLib import TTFont
from fontTools.merge import Merger
from fontTools import subset

def ttf(src, dst):
    f = TTFont(src); f.flavor = None; f.save(dst); return dst

parts = [ttf(${JSON.stringify(latin)}, ${JSON.stringify(join(work, `latin-${weight}.ttf`))}),
         ttf(${JSON.stringify(devanagari)}, ${JSON.stringify(join(work, `deva-${weight}.ttf`))})]
Merger().merge(parts).save(${JSON.stringify(merged)})

unis = set()
for part in ${JSON.stringify(UNICODES)}.split(','):
    if '-' in part:
        lo, hi = part.split('-')
        unis.update(range(int(lo, 16), int(hi, 16) + 1))
    else:
        unis.add(int(part, 16))

font = TTFont(${JSON.stringify(merged)})
opts = subset.Options()
opts.layout_features = ['*']   # keep GSUB/GPOS: conjuncts and matras live there
opts.hinting = False
opts.desubroutinize = True
opts.notdef_outline = True     # a missing glyph should look missing, not blank
s = subset.Subsetter(options=opts)
s.populate(unicodes=unis)
s.subset(font)
# fontTools stamps head.modified with the current time. Pinning it removes
# one source of churn between builds; it does not remove all of them.
font['head'].modified = 0
font['head'].created = 0
font.save(${JSON.stringify(subsetted)})
`);

  const raw = readFileSync(subsetted);
  // -n: no filename, no timestamp in the gzip header. That and the pinned
  // head timestamps above remove the two obvious sources of churn. They do
  // NOT make the build byte-reproducible — fontTools' merge still orders
  // some structures differently between runs, so regenerating produces a
  // large diff for identical input. Checked, not assumed: two consecutive
  // builds differ. Worth knowing before you read anything into that diff.
  const gzipped = execFileSync('gzip', ['-9', '-n', '-c'], {
    input: raw,
    maxBuffer: 64 * 1024 * 1024,
  });
  encoded[name] = gzipped.toString('base64');
  console.log(`${name}: ttf ${raw.length} bytes -> gzip ${gzipped.length} bytes`);
}

const header = `/**
 * The document fonts, inlined.
 *
 * GENERATED by \`scripts/build-fonts.mjs\`. Do not edit by hand.
 *
 * Noto Sans Devanagari, Latin and Devanagari subsets merged into one file and
 * cut down to what an invoice and a receipt print. One font covering both
 * scripts, so no text call has to know which script it is drawing: a member
 * named रवी कुलकर्णी and a member named Ravi Kulkarni go through the same code.
 *
 * Gzipped, then base64. They are in a source file rather than \`.ttf\` files
 * read from disk because reading them from disk does not survive bundling:
 * \`__dirname\` resolves into the build's chunk directory, the font files are
 * not copied there, and every invoice download fails with ENOENT. That was
 * found by requesting a PDF from a production build, and it would have
 * shipped otherwise.
 *
 * Licensed under the SIL Open Font License 1.1.
 */

`;

const body =
  `export const DOCUMENT_FONT_REGULAR_GZIP_BASE64 =\n  '${encoded.regular}';\n\n` +
  `export const DOCUMENT_FONT_BOLD_GZIP_BASE64 =\n  '${encoded.bold}';\n`;

writeFileSync('packages/integrations/src/pdf/fonts.ts', header + body);
console.log('Wrote packages/integrations/src/pdf/fonts.ts');
