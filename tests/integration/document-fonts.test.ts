import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import {
  DOCUMENT_FONT_BOLD_GZIP_BASE64,
  DOCUMENT_FONT_REGULAR_GZIP_BASE64,
} from '../../packages/integrations/src/pdf/fonts';
import { readFileSync } from 'node:fs';
import { hasUnsupportedScript } from '../../packages/integrations/src/pdf/typeface';

/**
 * The font the invoice and the receipt are printed with.
 *
 * This file exists because of a wrong comment. The PDF renderer carried a
 * "KNOWN LIMITATION, stated plainly: pdfkit does not shape complex scripts",
 * and `DEVELOPMENT_STATUS.md` repeated it, so a member in Maharashtra whose
 * name is written in Marathi was going to be handed a receipt of hollow
 * boxes — and `hasUnsupportedScript`, the stated mitigation, was exported
 * and never called by anything.
 *
 * pdfkit lays out through fontkit, which runs the Indic shaper. It was never
 * a shaping problem. The font was DejaVu Sans, which has no Devanagari in it
 * at all. Rendering proves it: with a Devanagari font, रवी कुलकर्णी comes out
 * correct down to the reph and the conjuncts.
 *
 * So these tests check COVERAGE, which is the thing that was actually wrong,
 * and they check it by reading the font's own cmap rather than by trusting a
 * comment. The cmap is parsed here by hand — about thirty lines — rather than
 * by adding a font library to the dependency tree for one assertion.
 */

/** Minimal TrueType cmap reader: codepoint -> glyph id, formats 4 and 12. */
function cmapLookup(font: Buffer): (codePoint: number) => number {
  expect(font.readUInt32BE(0)).toBe(0x00010000); // sfnt version: TrueType outlines

  const tableCount = font.readUInt16BE(4);
  let cmapOffset = 0;
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    if (font.toString('latin1', record, record + 4) === 'cmap') {
      cmapOffset = font.readUInt32BE(record + 8);
    }
  }
  expect(cmapOffset).toBeGreaterThan(0);

  // Prefer a Unicode subtable: (3,10) full repertoire, then (3,1) BMP.
  const subtableCount = font.readUInt16BE(cmapOffset + 2);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < subtableCount; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    const platform = font.readUInt16BE(record);
    const encoding = font.readUInt16BE(record + 2);
    const offset = font.readUInt32BE(record + 4);
    const score =
      platform === 3 && encoding === 10 ? 3 : platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = cmapOffset + offset;
    }
  }
  expect(bestScore).toBeGreaterThan(0);

  const format = font.readUInt16BE(best);

  if (format === 12) {
    const groups = font.readUInt32BE(best + 12);
    return (cp) => {
      for (let i = 0; i < groups; i += 1) {
        const g = best + 16 + i * 12;
        const start = font.readUInt32BE(g);
        const end = font.readUInt32BE(g + 4);
        if (cp >= start && cp <= end) return font.readUInt32BE(g + 8) + (cp - start);
      }
      return 0;
    };
  }

  expect(format).toBe(4);
  const segX2 = font.readUInt16BE(best + 6);
  const ends = best + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;

  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let s = 0; s < segX2; s += 2) {
      if (font.readUInt16BE(ends + s) < cp) continue;
      if (font.readUInt16BE(starts + s) > cp) return 0;
      const rangeOffset = font.readUInt16BE(rangeOffsets + s);
      if (rangeOffset === 0) {
        return (cp + font.readInt16BE(deltas + s)) & 0xffff;
      }
      const glyphAddress = rangeOffsets + s + rangeOffset + (cp - font.readUInt16BE(starts + s)) * 2;
      const glyph = font.readUInt16BE(glyphAddress);
      return glyph === 0 ? 0 : (glyph + font.readInt16BE(deltas + s)) & 0xffff;
    }
    return 0;
  };
}

const weights = {
  regular: gunzipSync(Buffer.from(DOCUMENT_FONT_REGULAR_GZIP_BASE64, 'base64')),
  bold: gunzipSync(Buffer.from(DOCUMENT_FONT_BOLD_GZIP_BASE64, 'base64')),
};

describe('the embedded document font', () => {
  for (const [weight, font] of Object.entries(weights)) {
    describe(weight, () => {
      const glyph = cmapLookup(font);

      it('covers the Latin a gym invoice prints', () => {
        for (const ch of 'ABCXYZabcxyz0123456789 .,-/:()') {
          expect({ ch, glyph: glyph(ch.codePointAt(0)!) }).toEqual({ ch, glyph: expect.any(Number) });
          expect(glyph(ch.codePointAt(0)!)).toBeGreaterThan(0);
        }
      });

      it('covers the rupee sign, which is why a font is embedded at all', () => {
        expect(glyph(0x20b9)).toBeGreaterThan(0);
      });

      it('covers Devanagari: consonants, matras, virama and digits', () => {
        // क ख ग घ — consonants
        for (let cp = 0x0915; cp <= 0x0918; cp += 1) expect(glyph(cp)).toBeGreaterThan(0);
        // ा ि ी ु ू — the matras that reorder around a consonant
        for (let cp = 0x093e; cp <= 0x0942; cp += 1) expect(glyph(cp)).toBeGreaterThan(0);
        // ् — the virama, without which no conjunct can form
        expect(glyph(0x094d)).toBeGreaterThan(0);
        // ळ — Marathi's own letter, absent from many Hindi-only fonts
        expect(glyph(0x0933)).toBeGreaterThan(0);
        // ० through ९
        for (let cp = 0x0966; cp <= 0x096f; cp += 1) expect(glyph(cp)).toBeGreaterThan(0);
      });

      it('covers ZWJ and ZWNJ, which decide whether a conjunct forms', () => {
        expect(glyph(0x200c)).toBeGreaterThan(0);
        expect(glyph(0x200d)).toBeGreaterThan(0);
      });

      it('carries the layout tables that position matras and build conjuncts', () => {
        const tableCount = font.readUInt16BE(4);
        const tables = new Set<string>();
        for (let i = 0; i < tableCount; i += 1) {
          tables.add(font.toString('latin1', 12 + i * 16, 12 + i * 16 + 4));
        }
        // Without GSUB there are no conjuncts; without GPOS the matras sit in
        // the wrong place. Subsetting is quite capable of dropping both.
        expect(tables.has('GSUB')).toBe(true);
        expect(tables.has('GPOS')).toBe(true);
      });

      it('does not pretend to cover scripts it has no glyphs for', () => {
        expect(glyph(0x0bb0)).toBe(0); // Tamil ர
        expect(glyph(0x0995)).toBe(0); // Bengali ক
        expect(glyph(0x0a95)).toBe(0); // Gujarati ક
      });
    });
  }

  it('is small enough to sit in a source file', () => {
    // Gzipped base64, both weights. The uncompressed pair is ~338 KB.
    const encoded = DOCUMENT_FONT_REGULAR_GZIP_BASE64.length + DOCUMENT_FONT_BOLD_GZIP_BASE64.length;
    expect(encoded).toBeLessThan(400_000);
  });
});

describe('hasUnsupportedScript, after the font changed', () => {
  it('passes the scripts the font now covers', () => {
    expect(hasUnsupportedScript('Ravi Kulkarni')).toBe(false);
    expect(hasUnsupportedScript('रवी कुलकर्णी')).toBe(false);
    expect(hasUnsupportedScript('श्री गणेश व्यायामशाळा')).toBe(false);
    expect(hasUnsupportedScript('छत्रपती संभाजीनगर')).toBe(false);
    expect(hasUnsupportedScript('₹1,500.00 — paid')).toBe(false);
    expect(hasUnsupportedScript('०१२३४५६७८९')).toBe(false);
  });

  it('still flags the scripts it does not', () => {
    expect(hasUnsupportedScript('ரவி')).toBe(true); // Tamil
    expect(hasUnsupportedScript('রবি')).toBe(true); // Bengali
    expect(hasUnsupportedScript('રવિ')).toBe(true); // Gujarati
    expect(hasUnsupportedScript('💪')).toBe(true);
  });

  it('flags a mixed string on the strength of its worst part', () => {
    expect(hasUnsupportedScript('रवी कुलकर्णी (Ravi)')).toBe(false);
    expect(hasUnsupportedScript('रवी कुलकर्णी', null, 'ரவி')).toBe(true);
  });

  // The check above and the font are two separate statements about the same
  // thing, and the original bug was exactly that kind of drift: the code said
  // Devanagari could not be rendered, and separately the font could not render
  // it, and nobody noticed the claim was about the wrong cause. A hand-written
  // allow-list that no longer matches the font is the same failure again — it
  // would pass a name straight through to a row of boxes.
  //
  // So: every codepoint the check permits must actually exist in both weights.
  // The other half of the same problem, and the one that actually bit.
  //
  // The drift test below checks that everything the allow-list accepts is in
  // the font. It says nothing about characters the RENDERERS THEMSELVES put
  // on the page — the ones that never pass through hasUnsupportedScript
  // because they are not a member's name, they are punctuation in the code.
  //
  // `−` U+2212, the true minus sign, is printed on the discount and payment
  // rows. It was in neither the old font subset nor the allow-list, so every
  // invoice that recorded a payment printed a hollow box next to the amount,
  // and had done since the invoice shipped. Nothing caught it: the allow-list
  // was self-consistent, the font was self-consistent, and the character came
  // from a template literal in between. It was found by rendering an invoice
  // and looking at it.
  //
  // So this reads the renderers and checks every non-ASCII character they
  // contain. Comment lines are skipped, crudely but deliberately: a prose
  // comment mentioning a script the font lacks should not fail the build.
  it('covers every non-ASCII character the renderers themselves print', () => {
    const sources = [
      'packages/integrations/src/pdf/invoice.ts',
      'packages/integrations/src/pdf/receipt.ts',
    ];

    const offenders = new Set<string>();
    for (const source of sources) {
      for (const line of readFileSync(source, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        for (const ch of line) {
          const cp = ch.codePointAt(0)!;
          if (cp > 0x7e && hasUnsupportedScript(ch)) {
            offenders.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} in ${source}`);
          }
        }
      }
    }

    expect([...offenders]).toEqual([]);
  });

  it('permits nothing the font cannot actually draw', () => {
    const glyphs = Object.entries(weights).map(
      ([weight, font]) => [weight, cmapLookup(font)] as const,
    );

    const missing: string[] = [];
    // Walk the whole BMP. Anything hasUnsupportedScript accepts is a promise
    // that the font can draw it.
    for (let cp = 0x20; cp <= 0xffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (hasUnsupportedScript(ch)) continue;
      for (const [weight, glyph] of glyphs) {
        if (glyph(cp) === 0) missing.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${weight})`);
      }
    }

    expect(missing).toEqual([]);
  });
});
