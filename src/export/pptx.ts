/**
 * src/export/pptx.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Export slide deck to .pptx using pptxgenjs (bundled locally, zero network).
 * Returns the file as a byte array that the main process writes to disk.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import PptxGenJS from 'pptxgenjs';
import type { Slide } from '../types';

export async function exportPptx(slides: Slide[]): Promise<number[]> {
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Doc to Slides';

  for (const slide of slides) {
    const pSlide = pptx.addSlide();

    // Dark background
    pSlide.background = { color: '0f1117' };

    // Icon
    pSlide.addText(slide.icon, {
      x: 0.5, y: 0.3, w: 1, h: 0.8,
      fontSize: 32,
    });

    // Title
    pSlide.addText(slide.title, {
      x: 0.5, y: 1.0, w: 12, h: 1.2,
      fontSize: 32,
      bold: true,
      color: '4f8ef7',
      fontFace: 'Segoe UI',
      wrap: true,
    });

    // Bullets
    if (slide.bullets.length > 0) {
      pSlide.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: 0.5, y: 2.3, w: 12, h: 3.5,
          fontSize: 18,
          color: 'e8eaf0',
          fontFace: 'Segoe UI',
          wrap: true,
        }
      );
    }

    // Speaker notes
    if (slide.notes) {
      pSlide.addNotes(slide.notes);
    }
  }

  // pptxgenjs can return a Buffer in Node context via the 'arraybuffer' type
  const buffer = await pptx.write({ outputType: 'arraybuffer' });
  return Array.from(new Uint8Array(buffer as ArrayBuffer));
}
