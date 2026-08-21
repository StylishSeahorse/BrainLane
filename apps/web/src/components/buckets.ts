/**
 * Backlog horizons — the vocabulary, shared by both sides of the RSC boundary.
 *
 * Deliberately a plain module with no `'use client'` directive. These constants
 * were previously exported from `bucket-picker.tsx`, which is a client
 * component: every export of such a module becomes a client *reference* when a
 * server component imports it, so `BUCKET_ORDER` arrived on the server as an
 * opaque proxy rather than an array and sorting the backlog crashed the page.
 *
 * Data that both sides need lives in a file that is neither.
 */

export type Bucket = 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY';

export const BUCKET_LABELS: Record<Bucket, string> = {
  SOON: 'Soon',
  THIS_MONTH: 'This month',
  THIS_QUARTER: 'This quarter',
  LATER: 'Later',
  SOMEDAY: 'Someday',
};

/** Nearest horizon first — the order the backlog is read in. */
export const BUCKET_ORDER: Bucket[] = ['SOON', 'THIS_MONTH', 'THIS_QUARTER', 'LATER', 'SOMEDAY'];
