/**
 * src/ui/StepBar.tsx
 * Top navigation bar showing which of the 3 steps is active.
 */
import React from 'react';
import type { AppStep } from '../types';
import styles from './StepBar.module.css';

const STEPS: { id: AppStep; label: string }[] = [
  { id: 'add', label: '1. Add Documents' },
  { id: 'review', label: '2. Review & Edit' },
  { id: 'present', label: '3. Present & Export' },
];

interface Props {
  currentStep: AppStep;
}

export function StepBar({ currentStep }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  // Only macOS needs a custom drag region: it uses a hidden title bar. On
  // Windows the window has a native frame, and an app-region strip there makes
  // that whole area a window-caption zone, where file drops are ignored.
  const isMac = window.electronAPI?.platform === 'darwin';

  return (
    <header
      className={styles.bar}
      role="banner"
      style={isMac ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div className={styles.brand} aria-label="Doc to Slides">
        <span className={styles.logo}>🗂️</span>
        <span className={styles.brandName}>Doc to Slides</span>
      </div>
      <nav aria-label="Application steps">
        <ol className={styles.steps}>
          {STEPS.map((step, idx) => (
            <li
              key={step.id}
              className={[
                styles.step,
                idx === currentIndex ? styles.active : '',
                idx < currentIndex ? styles.done : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={idx === currentIndex ? 'step' : undefined}
            >
              <span className={styles.stepNum}>{idx + 1}</span>
              <span className={styles.stepLabel}>{step.label.slice(3)}</span>
            </li>
          ))}
        </ol>
      </nav>
    </header>
  );
}
