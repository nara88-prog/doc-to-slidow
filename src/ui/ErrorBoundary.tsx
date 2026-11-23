/**
 * src/ui/ErrorBoundary.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Last-resort guard so a rendering error inside one step can never leave the
 * window completely blank. Shows a readable message and a way back.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React from 'react';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: React.ReactNode;
  onReset: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the details in the console for debugging; never send them anywhere.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset();
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className={styles.wrap} role="alert">
        <span className={styles.icon}>⚠️</span>
        <h2 className={styles.title}>Something went wrong on this screen</h2>
        <p className={styles.message}>{this.state.error.message}</p>
        <button className={styles.button} onClick={this.handleReset}>
          ← Back to documents
        </button>
      </div>
    );
  }
}
