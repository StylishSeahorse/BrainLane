import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signUp } from '@/app/actions';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/server/auth/session';

export default async function SignupPage() {
  if (await getCurrentUser()) redirect('/today');

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight">
            <span className="bg-primary size-2.5 rounded-full" aria-hidden="true" />
            Fluid
          </h1>
          <p className="text-base-content/60 mt-1 text-sm">Create an account.</p>
        </div>

        <div className="card bg-base-100 border-base-300 border shadow-sm">
          <div className="card-body">
            <AuthForm
              action={signUp}
              submitLabel="Create account"
              autoComplete="new-password"
              // Length, not character classes: length is what correlates with
              // strength, and class rules push people toward predictable
              // substitutions.
              passwordHint="At least 12 characters. A few unrelated words works well."
            />

            <p className="text-base-content/60 mt-2 text-center text-sm">
              Already have an account?{' '}
              <Link href="/login" className="link link-primary">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
