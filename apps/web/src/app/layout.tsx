import type { Metadata, Viewport } from 'next';
import { prisma } from '@fluid/db';
import { getCurrentUser } from '@/server/auth/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fluid',
  description: 'A calendar that negotiates with you.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Respects the theme in the browser chrome on mobile.
  themeColor: '#fbfaf8',
};

/**
 * Accessibility preferences are resolved server-side and stamped on <html>
 * before first paint. Doing this in an effect would flash the default theme
 * first, which for someone who asked for high contrast or reduced motion is
 * precisely the thing they asked to avoid.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const preferences = user
    ? await prisma.userPreferences.findUnique({ where: { userId: user.id } })
    : null;

  return (
    <html
      lang="en"
      data-theme={preferences?.highContrast ? 'fluidcontrast' : 'fluid'}
      data-motion={preferences?.reducedMotion ? 'reduced' : undefined}
      data-dyslexia={preferences?.dyslexiaFont ? 'on' : undefined}
      data-text={preferences?.largeText ? 'large' : undefined}
    >
      <body className="min-h-dvh bg-base-200 antialiased">{children}</body>
    </html>
  );
}
