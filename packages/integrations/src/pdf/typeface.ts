import { gunzipSync } from 'node:zlib';
import { DOCUMENT_FONT_BOLD_GZIP_BASE64, DOCUMENT_FONT_REGULAR_GZIP_BASE64 } from './fonts';

/**
 * The typeface both PDF documents use, decompressed once per process.
 *
 * Noto Sans Devanagari with its Latin and Devanagari subsets merged, so one
 * font covers a member called Ravi Kulkarni and a member called रवी कुलकर्णी.
 * See `scripts/build-fonts.mjs` for how it is built and why it is one font
 * rather than two.
 *
 * pdfkit lays text out through fontkit, which runs the Indic shaper, so
 * matras, conjuncts and the reph are positioned by the font's own GSUB and
 * GPOS tables. Nothing here has to know that: it hands pdfkit a buffer.
 */

let regular: Buffer | null = null;
let bold: Buffer | null = null;

export function documentFonts(): { regular: Buffer; bold: Buffer } {
  // gunzip costs about a millisecond and happens on the first PDF of the
  // process, not on every one.
  regular ??= gunzipSync(Buffer.from(DOCUMENT_FONT_REGULAR_GZIP_BASE64, 'base64'));
  bold ??= gunzipSync(Buffer.from(DOCUMENT_FONT_BOLD_GZIP_BASE64, 'base64'));
  return { regular, bold };
}

/**
 * Whether any text would fall outside the embedded font.
 *
 * The font covers printable Latin, the rupee sign, a few typographic marks
 * and the whole Devanagari block — so Hindi, Marathi, Sanskrit, Konkani and
 * Nepali names all render properly. What it does not cover is every other
 * script: Tamil, Telugu, Kannada, Bengali, Gujarati, Urdu, and emoji. Those
 * would come out as hollow boxes, and it is better to know that before the
 * document reaches a member's hand.
 *
 * This used to return true for Devanagari too, on the stated grounds that
 * "pdfkit cannot shape complex scripts". It can; it was never given a font
 * that had the glyphs. The list below is now a statement about coverage,
 * which is testable, rather than about shaping, which was wrong.
 */
export function hasUnsupportedScript(...values: Array<string | null | undefined>): boolean {
  return values.some(
    (value) => value != null && Array.from(value).some((ch) => !covered(ch.codePointAt(0)!)),
  );
}

/**
 * The codepoints the embedded font carries, as ranges.
 *
 * Deliberately not a regular expression character class. The obvious way to
 * write this is `/^[\u0020-\u007E\u0900-\u097F...]*$/`, and two things go
 * wrong with it: the escapes get flattened into literal characters by any
 * tool that rewrites the file — a literal non-breaking space and a zero-width
 * joiner are invisible in a source file, and this list decides whether a
 * member's name prints or a row of boxes does — and a class holding Devanagari
 * matras is genuinely ambiguous about whether it matches a combining sequence
 * or its parts. Numbers have neither problem.
 *
 * Kept in step with the font by a test that walks the BMP and checks that
 * everything this accepts has a glyph in both weights.
 */
const COVERED: ReadonlyArray<readonly [number, number]> = [
  [0x0020, 0x007e], // printable ASCII
  [0x00a0, 0x00a0], // no-break space
  [0x00b7, 0x00b7], // middle dot
  [0x0900, 0x097f], // Devanagari: Hindi, Marathi, Sanskrit, Konkani, Nepali
  [0x200c, 0x200d], // ZWNJ and ZWJ — these decide whether a conjunct forms
  [0x2013, 0x2014], // en dash, em dash
  [0x2018, 0x2019], // curly single quotes
  [0x201c, 0x201d], // curly double quotes
  [0x2022, 0x2022], // bullet
  [0x2026, 0x2026], // ellipsis
  [0x2212, 0x2212], // true minus sign — the invoice prints it, not a hyphen
  [0x20b9, 0x20b9], // the rupee sign, which is why a font is embedded at all
];

function covered(codePoint: number): boolean {
  return COVERED.some(([low, high]) => codePoint >= low && codePoint <= high);
}
