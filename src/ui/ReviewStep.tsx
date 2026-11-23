/**
 * src/ui/ReviewStep.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 2: Editable slide workspace.
 * Features:
 *   - Side panel: list of slides (drag-to-reorder via keyboard/mouse)
 *   - Main area: edit title, bullets, notes for the selected slide
 *   - Theme picker
 *   - Add / delete / duplicate slide buttons
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useCallback } from 'react';
import type { Slide, Theme } from '../types';
import type { ToastKind } from './Toast';
import styles from './ReviewStep.module.css';

interface Props {
  slides: Slide[];
  onSlideChange: (slides: Slide[]) => void;
  onBack: () => void;
  onPresent: (slides: Slide[]) => void;
  showToast: (msg: string, kind?: ToastKind) => void;
}

const THEMES: Theme[] = [
  { id: 'dark',    name: 'Midnight',  bg: '#0f1117', surface: '#1a1d27', text: '#e8eaf0', accent: '#4f8ef7', headingFont: '"Segoe UI",system-ui,sans-serif' },
  { id: 'light',   name: 'Clean',     bg: '#f4f6fb', surface: '#ffffff', text: '#1a1d27', accent: '#3b6fe0', headingFont: '"Segoe UI",system-ui,sans-serif' },
  { id: 'ocean',   name: 'Ocean',     bg: '#0a1930', surface: '#102040', text: '#cce4ff', accent: '#38bdf8', headingFont: '"Segoe UI",system-ui,sans-serif' },
  { id: 'forest',  name: 'Forest',    bg: '#0d1f17', surface: '#132a1e', text: '#d2f0de', accent: '#4ade80', headingFont: '"Segoe UI",system-ui,sans-serif' },
  { id: 'sunset',  name: 'Sunset',    bg: '#1f0a0a', surface: '#2a1010', text: '#fde8d0', accent: '#fb923c', headingFont: '"Segoe UI",system-ui,sans-serif' },
];

let _sid = 1000;
function newSlideId() { return String(++_sid); }

export function ReviewStep({ slides, onSlideChange, onBack, onPresent, showToast }: Props) {
  const [selectedId, setSelectedId] = useState<string>(slides[0]?.id ?? '');
  const [themeId, setThemeId] = useState('dark');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
  const selectedSlide = slides.find((s) => s.id === selectedId);

  // ── Slide list mutation helpers ───────────────────────────────────────────

  const updateSlide = useCallback((id: string, patch: Partial<Slide>) => {
    onSlideChange(slides.map((s) => s.id === id ? { ...s, ...patch } : s));
  }, [slides, onSlideChange]);

  const addSlide = useCallback(() => {
    const newSlide: Slide = {
      id: newSlideId(),
      type: 'content',
      title: 'New Slide',
      bullets: ['Add your first bullet here'],
      notes: '',
      icon: '📌',
    };
    const idx = slides.findIndex((s) => s.id === selectedId);
    const updated = [...slides];
    updated.splice(idx + 1, 0, newSlide);
    onSlideChange(updated);
    setSelectedId(newSlide.id);
  }, [slides, selectedId, onSlideChange]);

  const duplicateSlide = useCallback(() => {
    if (!selectedSlide) return;
    const dupe: Slide = { ...selectedSlide, id: newSlideId(), title: selectedSlide.title + ' (copy)' };
    const idx = slides.findIndex((s) => s.id === selectedId);
    const updated = [...slides];
    updated.splice(idx + 1, 0, dupe);
    onSlideChange(updated);
    setSelectedId(dupe.id);
    showToast('Slide duplicated.', 'success');
  }, [slides, selectedId, selectedSlide, onSlideChange, showToast]);

  const deleteSlide = useCallback(() => {
    if (slides.length === 1) {
      showToast('Cannot delete the last slide.', 'error');
      return;
    }
    const idx = slides.findIndex((s) => s.id === selectedId);
    const updated = slides.filter((s) => s.id !== selectedId);
    onSlideChange(updated);
    setSelectedId(updated[Math.max(0, idx - 1)].id);
    showToast('Slide deleted.', 'info');
  }, [slides, selectedId, onSlideChange, showToast]);

  // ── Drag-to-reorder ───────────────────────────────────────────────────────

  const handleDragStart = (id: string) => setDraggingId(id);

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  };

  const handleDrop = (_e: React.DragEvent, targetId: string) => {
    if (!draggingId || draggingId === targetId) {
      setDragOverId(null);
      setDraggingId(null);
      return;
    }
    const from = slides.findIndex((s) => s.id === draggingId);
    const to = slides.findIndex((s) => s.id === targetId);
    const updated = [...slides];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    onSlideChange(updated);
    setDragOverId(null);
    setDraggingId(null);
  };

  // ── Bullet editing ────────────────────────────────────────────────────────

  const updateBullet = (idx: number, value: string) => {
    if (!selectedSlide) return;
    const bullets = [...selectedSlide.bullets];
    bullets[idx] = value;
    updateSlide(selectedId, { bullets });
  };

  const addBullet = () => {
    if (!selectedSlide || selectedSlide.bullets.length >= 5) return;
    updateSlide(selectedId, { bullets: [...selectedSlide.bullets, ''] });
  };

  const removeBullet = (idx: number) => {
    if (!selectedSlide) return;
    const bullets = selectedSlide.bullets.filter((_, i) => i !== idx);
    updateSlide(selectedId, { bullets });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (slides.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p>No slides were generated. Try adding more documents.</p>
        <button className={styles.btnSecondary} onClick={onBack}>← Back</button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* Slide list panel */}
      <aside className={styles.panel} aria-label="Slide list">
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Slides ({slides.length})</span>
          <button className={styles.btnIconSmall} onClick={addSlide} title="Add slide" aria-label="Add new slide">＋</button>
        </div>

        {/* Theme picker */}
        <div className={styles.themePicker} aria-label="Theme picker">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={[styles.themeChip, themeId === t.id ? styles.themeActive : ''].join(' ')}
              style={{ background: t.bg, border: `2px solid ${themeId === t.id ? t.accent : 'transparent'}` }}
              onClick={() => setThemeId(t.id)}
              aria-label={`Apply ${t.name} theme`}
              aria-pressed={themeId === t.id}
              title={t.name}
            >
              <span style={{ color: t.text, fontSize: 10 }}>{t.name}</span>
            </button>
          ))}
        </div>

        <ul className={styles.slideList} aria-label="Reorderable slide list">
          {slides.map((slide, idx) => (
            <li
              key={slide.id}
              className={[
                styles.slideThumb,
                slide.id === selectedId ? styles.slideSelected : '',
                slide.id === dragOverId ? styles.slideDragOver : '',
              ].join(' ')}
              draggable
              onDragStart={() => handleDragStart(slide.id)}
              onDragOver={(e) => handleDragOver(e, slide.id)}
              onDrop={(e) => handleDrop(e, slide.id)}
              onDragEnd={() => { setDragOverId(null); setDraggingId(null); }}
              onClick={() => setSelectedId(slide.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(slide.id); }}
              aria-label={`Slide ${idx + 1}: ${slide.title}`}
              aria-selected={slide.id === selectedId}
            >
              <span className={styles.thumbNum}>{idx + 1}</span>
              <span className={styles.thumbIcon}>{slide.icon}</span>
              <span className={styles.thumbTitle}>{slide.title}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* Editor panel */}
      <main className={styles.editor} aria-label="Slide editor">
        {selectedSlide ? (
          <>
            {/* Live preview */}
            <div
              className={styles.preview}
              style={{ background: theme.bg, color: theme.text, fontFamily: theme.headingFont }}
              aria-label="Slide preview"
            >
              <div className={styles.previewInner}>
                <div className={styles.previewIcon}>{selectedSlide.icon}</div>
                <h2 className={styles.previewTitle} style={{ color: theme.accent }}>
                  {selectedSlide.title}
                </h2>
                <ul className={styles.previewBullets}>
                  {selectedSlide.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
              <div className={styles.previewNotes} style={{ borderTopColor: `${theme.accent}33` }}>
                <span style={{ color: theme.accent, fontWeight: 600, fontSize: 12 }}>Speaker notes: </span>
                {selectedSlide.notes || <em style={{ opacity: 0.5 }}>None</em>}
              </div>
            </div>

            {/* Edit form */}
            <div className={styles.editForm}>
              <div className={styles.editRow}>
                <label className={styles.editLabel} htmlFor="edit-title">
                  Title
                </label>
                <input
                  id="edit-title"
                  className={styles.editInput}
                  value={selectedSlide.title}
                  onChange={(e) => updateSlide(selectedId, { title: e.target.value })}
                  aria-label="Slide title"
                />
              </div>

              <div className={styles.editRow}>
                <label className={styles.editLabel}>Bullets</label>
                <ul className={styles.bulletList}>
                  {selectedSlide.bullets.map((b, i) => (
                    <li key={i} className={styles.bulletItem}>
                      <input
                        className={styles.editInput}
                        value={b}
                        onChange={(e) => updateBullet(i, e.target.value)}
                        aria-label={`Bullet ${i + 1}`}
                      />
                      <button
                        className={styles.btnIconSmall}
                        onClick={() => removeBullet(i)}
                        aria-label={`Remove bullet ${i + 1}`}
                        title="Remove bullet"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                {selectedSlide.bullets.length < 5 && (
                  <button className={styles.btnAddBullet} onClick={addBullet}>
                    + Add bullet
                  </button>
                )}
              </div>

              <div className={styles.editRow}>
                <label className={styles.editLabel} htmlFor="edit-notes">
                  Speaker Notes
                </label>
                <textarea
                  id="edit-notes"
                  className={styles.editTextarea}
                  value={selectedSlide.notes}
                  onChange={(e) => updateSlide(selectedId, { notes: e.target.value })}
                  rows={3}
                  aria-label="Speaker notes"
                />
              </div>

              <div className={styles.slideActions}>
                <button className={styles.btnSecondary} onClick={duplicateSlide} aria-label="Duplicate slide">
                  ⧉ Duplicate
                </button>
                <button className={styles.btnDanger} onClick={deleteSlide} aria-label="Delete slide">
                  🗑 Delete
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className={styles.empty}>Select a slide to edit it.</div>
        )}
      </main>

      {/* Footer toolbar */}
      <footer className={styles.toolbar}>
        <button className={styles.btnSecondary} onClick={onBack} aria-label="Back to add documents">
          ← Back
        </button>
        <button
          className={styles.btnPrimary}
          onClick={() => onPresent(slides)}
          aria-label="Proceed to present and export"
        >
          Present & Export →
        </button>
      </footer>
    </div>
  );
}
