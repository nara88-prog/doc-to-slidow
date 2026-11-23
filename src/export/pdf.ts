/**
 * src/export/pdf.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PDF export: generates an HTML string of all slides and opens Electron's
 * printToPDF dialog on the hidden off-screen window via a custom IPC call.
 *
 * Since we're in the renderer context, we use the system print dialog —
 * the user picks "Save as PDF" from the native dialog.
 * This avoids bundling a full headless Chrome binary.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Slide } from '../types';
import { exportHtml } from './html';

/**
 * Open a new hidden window containing the HTML export, then trigger the
 * browser's native print dialog (Ctrl+P / Cmd+P).
 * The user selects "Save as PDF" in their OS print dialog.
 *
 * Note: `targetPath` is passed for context but the OS controls the save location.
 */
export async function exportPdf(slides: Slide[], _targetPath: string): Promise<void> {
  const html = exportHtml(slides);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  // Open in a new window so we don't disrupt the main UI
  const win = window.open(url, '_blank', 'width=1280,height=800');
  if (!win) throw new Error('Could not open print window. Check pop-up blocker settings.');

  // Wait for the page to load, then trigger print
  win.onload = () => {
    setTimeout(() => {
      win.print();
      URL.revokeObjectURL(url);
    }, 500);
  };
}
