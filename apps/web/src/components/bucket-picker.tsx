'use client';

import { useTransition } from 'react';
import { setTaskBucket } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { BUCKET_LABELS, BUCKET_ORDER, type Bucket } from '@/components/buckets';

/**
 * Roughly when a piece of work wants to happen.
 *
 * Coarse on purpose. Putting a precise date on something nobody has committed
 * to manufactures a deadline, and a manufactured deadline that passes reads
 * exactly like a real failure — which is the machinery of guilt this product
 * exists to dismantle. "Sometime this month" lets a person be honestly right.
 */

export function BucketPicker({ taskId, current }: { taskId: string; current: Bucket }) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      className="select select-xs w-auto rounded-lg"
      value={current}
      disabled={pending}
      aria-label="When this should happen"
      onChange={(event) => {
        const bucket = event.target.value as Bucket;
        startTransition(async () => {
          const formData = new FormData();
          formData.set('id', taskId);
          formData.set('bucket', bucket);
          const result = await setTaskBucket(formData);
          logAction(
            result.error ?? `Moved to ${BUCKET_LABELS[bucket].toLowerCase()}.`,
            result.error ? 'error' : 'success',
          );
        });
      }}
    >
      {BUCKET_ORDER.map((bucket) => (
        <option key={bucket} value={bucket}>
          {BUCKET_LABELS[bucket]}
        </option>
      ))}
    </select>
  );
}
