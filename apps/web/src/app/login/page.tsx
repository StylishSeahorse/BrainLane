import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signIn } from '@/app/actions';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/server/auth/session';

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/today');

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight">
            <span className="bg-primary size-2.5 rounded-full" aria-hidden="true" />
            Fluid
          </h1>
          <p className="text-base-content/60 mt-1 text-sm">A calendar that negotiates with you.</p>
        </div>

        <div className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body">
            <AuthForm action={signIn} submitLabel="Sign in" autoComplete="current-password" />

            <p className="text-base-content/60 mt-2 text-center text-sm">
              No account yet?{' '}
              <Link href="/signup" className="link link-primary">
                Create one
              </Link>
            </p>
          </div>
        </div>

        <div className="alert mt-4 text-xs">
          <span>
            Demo account: <code className="font-mono">demo@fluid.local</code> /{' '}
            <code className="font-mono">demo-password-1234</code>
          </span>
        </div>
      </div>
    </main>
  );
}
