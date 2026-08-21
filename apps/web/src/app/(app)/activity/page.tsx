import { redirect } from 'next/navigation';

/**
 * What the AI did is reflection material, so the activity log now sits on the
 * Review page beside the rest of the week's evidence.
 */
export default function ActivityPage() {
  redirect('/review#activity');
}
