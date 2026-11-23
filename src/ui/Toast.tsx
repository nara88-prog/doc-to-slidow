/**
 * src/ui/Toast.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight toast notification system.
 * Usage: const { toasts, showToast, dismissToast } = useToast();
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useCallback, useEffect } from 'react';
import styles from './Toast.module.css';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastData {
  id: string;
  message: string;
  kind: ToastKind;
}

interface Props {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={[styles.toast, styles[toast.kind]].join(' ')}
      role="alert"
      aria-live="assertive"
    >
      <span className={styles.msg}>{toast.message}</span>
      <button
        className={styles.close}
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

let _id = 0;
function nextId() { return String(++_id); }

export function useToast() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const showToast = useCallback((message: string, kind: ToastKind = 'info') => {
    setToasts((prev) => [...prev, { id: nextId(), message, kind }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
