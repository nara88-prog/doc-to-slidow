/**
 * src/App.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Root component. Manages the three-step flow:
 *   Step 1 — Add documents  (AddStep)
 *   Step 2 — Review summary (ReviewStep)
 *   Step 3 — Present & Export (PresentStep)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useCallback } from 'react';
import type { AppStep, QueueItem, Slide } from './types';
import { AddStep } from './ui/AddStep';
import { ReviewStep } from './ui/ReviewStep';
import { PresentStep } from './ui/PresentStep';
import { StepBar } from './ui/StepBar';
import { Toast, useToast } from './ui/Toast';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { normalizeSlides } from './lib/normalizeSlides';
import styles from './App.module.css';

export default function App() {
  const [step, setStep] = useState<AppStep>('add');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [slides, setSlides] = useState<Slide[]>([]);
  const { toasts, showToast, dismissToast } = useToast();

  const handleSlidesReady = useCallback((incoming: Slide[]) => {
    // Never hand the UI a half-formed deck — an unexpected shape is what turns
    // step 2 into a blank screen.
    const clean = normalizeSlides(incoming);

    if (clean.length === 0) {
      // Stay on step 1 so the user can see which documents failed and retry.
      showToast(
        'No readable text found in those documents. Check the queue for details and try another file or link.',
        'error'
      );
      return;
    }

    setSlides(clean);
    setStep('review');
    showToast(`Slide deck generated — ${clean.length} slides.`, 'success');
  }, [showToast]);

  const handleProceedToPresent = useCallback((updatedSlides: Slide[]) => {
    setSlides(normalizeSlides(updatedSlides));
    setStep('present');
  }, []);

  const handleBackToAdd = useCallback(() => setStep('add'), []);
  const handleBackToReview = useCallback(() => setStep('review'), []);

  return (
    <div className={styles.app}>
      <StepBar currentStep={step} />

      <main className={styles.main}>
        {/* key={step} resets the boundary whenever the step changes. */}
        <ErrorBoundary key={step} onReset={handleBackToAdd}>
          {step === 'add' && (
            <AddStep
              queue={queue}
              onQueueChange={setQueue}
              onSlidesReady={handleSlidesReady}
              showToast={showToast}
            />
          )}
          {step === 'review' && (
            <ReviewStep
              slides={slides}
              onSlideChange={setSlides}
              onBack={handleBackToAdd}
              onPresent={handleProceedToPresent}
              showToast={showToast}
            />
          )}
          {step === 'present' && (
            <PresentStep
              slides={slides}
              onBack={handleBackToReview}
              showToast={showToast}
            />
          )}
        </ErrorBoundary>
      </main>

      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
