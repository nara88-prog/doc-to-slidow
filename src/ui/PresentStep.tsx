/**
 * src/ui/PresentStep.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 3: Present mode + Export (PPTX, PDF, HTML).
 *
 * Present mode: fullscreen overlay, arrow-key navigation, ESC to exit.
 * Export: delegates to the exporters in src/export/.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useCallback, useEffect } from 'react';
import type { Slide } from '../types';
import type { ToastKind } from './Toast';
import { exportPptx } from '../export/pptx';
import { exportHtml } from '../export/html';
import { exportPdf } from '../export/pdf';
import styles from './PresentStep.module.css';

interface Props {
  slides: Slide[];
  onBack: () => void;
  showToast: (msg: string, kind?: ToastKind) => void;
}

export function PresentStep({ slides, onBack, showToast }: Props) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const current = slides[currentIdx];
  const total = slides.length;

  const goNext = useCallback(() => setCurrentIdx((i) => Math.min(i + 1, total - 1)), [total]);
  const goPrev = useCallback(() => setCurrentIdx((i) => Math.max(i - 1, 0)), []);

  // Keyboard navigation
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') goNext();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goPrev();
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen, goNext, goPrev]);

  // ── Export handlers ───────────────────────────────────────────────────────

  const handleExportPptx = async () => {
    try {
      const path = await window.electronAPI.saveFile('presentation.pptx', 'pptx');
      if (!path) return;
      const bytes = await exportPptx(slides);
      await window.electronAPI.writeFile(path, bytes);
      showToast('Exported as PPTX!', 'success');
    } catch (err) {
      showToast(`PPTX export failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleExportHtml = async () => {
    try {
      const path = await window.electronAPI.saveFile('presentation.html', 'html');
      if (!path) return;
      const html = exportHtml(slides);
      const bytes = Array.from(new TextEncoder().encode(html));
      await window.electronAPI.writeFile(path, bytes);
      showToast('Exported as standalone HTML!', 'success');
    } catch (err) {
      showToast(`HTML export failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleExportPdf = async () => {
    try {
      const path = await window.electronAPI.saveFile('presentation.pdf', 'pdf');
      if (!path) return;
      showToast('PDF export uses your system print dialog — select "Save as PDF".', 'info');
      await exportPdf(slides, path);
    } catch (err) {
      showToast(`PDF export failed: ${(err as Error).message}`, 'error');
    }
  };

  // ── Fullscreen present mode ───────────────────────────────────────────────

  if (isFullscreen) {
    return (
      <div
        className={styles.fullscreen}
        style={{ background: '#0f1117' }}
        role="presentation"
        aria-label={`Slide ${currentIdx + 1} of ${total}: ${current.title}`}
      >
        <div className={styles.fsSlide}>
          <div className={styles.fsIcon}>{current.icon}</div>
          <h1 className={styles.fsTitle}>{current.title}</h1>
          <ul className={styles.fsBullets}>
            {current.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>

        <div className={styles.fsControls}>
          <button
            className={styles.fsBtn}
            onClick={goPrev}
            disabled={currentIdx === 0}
            aria-label="Previous slide"
          >
            ◀
          </button>
          <span className={styles.fsCounter} aria-live="polite">
            {currentIdx + 1} / {total}
          </span>
          <button
            className={styles.fsBtn}
            onClick={goNext}
            disabled={currentIdx === total - 1}
            aria-label="Next slide"
          >
            ▶
          </button>
          <button
            className={styles.fsExit}
            onClick={() => setIsFullscreen(false)}
            aria-label="Exit presentation mode"
          >
            ✕ Exit
          </button>
        </div>

        {/* Notes overlay */}
        {current.notes && (
          <div className={styles.fsNotes} aria-label="Speaker notes">
            {current.notes}
          </div>
        )}
      </div>
    );
  }

  // ── Normal view ───────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>
      {/* Slide navigator */}
      <section className={styles.navigator} aria-label="Slide navigator">
        <div className={styles.navHeader}>
          <button className={styles.navBtn} onClick={goPrev} disabled={currentIdx === 0} aria-label="Previous slide">◀</button>
          <span className={styles.navCounter} aria-live="polite">{currentIdx + 1} / {total}</span>
          <button className={styles.navBtn} onClick={goNext} disabled={currentIdx === total - 1} aria-label="Next slide">▶</button>
        </div>

        {/* Current slide preview */}
        <div className={styles.slidePreview} aria-label={`Slide ${currentIdx + 1}: ${current.title}`}>
          <div className={styles.previewIcon}>{current.icon}</div>
          <h2 className={styles.previewTitle}>{current.title}</h2>
          <ul className={styles.previewBullets}>
            {current.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>

        {/* Slide strip */}
        <ul className={styles.strip} aria-label="All slides">
          {slides.map((s, idx) => (
            <li
              key={s.id}
              className={[styles.stripItem, idx === currentIdx ? styles.stripActive : ''].join(' ')}
              role="button"
              tabIndex={0}
              aria-label={`Go to slide ${idx + 1}: ${s.title}`}
              aria-current={idx === currentIdx ? 'true' : undefined}
              onClick={() => setCurrentIdx(idx)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setCurrentIdx(idx); }}
            >
              <span className={styles.stripNum}>{idx + 1}</span>
              <span className={styles.stripTitle}>{s.title}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Export + controls */}
      <aside className={styles.sidebar} aria-label="Export options">
        <h2 className={styles.sideTitle}>Export</h2>

        <button className={styles.exportBtn} onClick={handleExportPptx} aria-label="Export as PowerPoint PPTX">
          <span className={styles.exportIcon}>📊</span>
          <span>
            <strong>PPTX</strong>
            <span className={styles.exportSub}>PowerPoint format</span>
          </span>
        </button>

        <button className={styles.exportBtn} onClick={handleExportPdf} aria-label="Export as PDF">
          <span className={styles.exportIcon}>📄</span>
          <span>
            <strong>PDF</strong>
            <span className={styles.exportSub}>Print-ready document</span>
          </span>
        </button>

        <button className={styles.exportBtn} onClick={handleExportHtml} aria-label="Export as standalone HTML">
          <span className={styles.exportIcon}>🌐</span>
          <span>
            <strong>HTML</strong>
            <span className={styles.exportSub}>Standalone web page</span>
          </span>
        </button>

        <hr className={styles.divider} />

        <button
          className={styles.presentBtn}
          onClick={() => setIsFullscreen(true)}
          aria-label="Start fullscreen presentation"
        >
          ▶ Start Presentation
        </button>

        <button className={styles.btnSecondary} onClick={onBack} aria-label="Back to slide review">
          ← Back to Review
        </button>
      </aside>
    </div>
  );
}
