/**
 * src/lib/normalizeSlides.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Defensive boundary between the pipeline worker and the UI.
 *
 * The worker returns plain objects over IPC. If a slide is missing a field
 * (bullets, notes, icon…), the Review step would throw during render and React
 * would unmount the whole app — which is exactly what a "blank page" looks
 * like. Normalizing here guarantees every slide has the shape the UI expects.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Slide, SlideType } from '../types';

const SLIDE_TYPES: SlideType[] = ['title', 'content', 'conclusion'];

export function normalizeSlides(input: unknown): Slide[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object')
    .map((raw, index) => {
      const bullets = Array.isArray(raw.bullets)
        ? raw.bullets.filter((b): b is string => typeof b === 'string')
        : [];

      const title =
        typeof raw.title === 'string' && raw.title.trim().length > 0
          ? raw.title
          : `Slide ${index + 1}`;

      const type = SLIDE_TYPES.includes(raw.type as SlideType)
        ? (raw.type as SlideType)
        : 'content';

      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : String(index + 1),
        type,
        title,
        bullets,
        notes: typeof raw.notes === 'string' ? raw.notes : '',
        icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : '📌',
      } satisfies Slide;
    });
}
