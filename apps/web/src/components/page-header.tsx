import Link from 'next/link';
import { ArrowRightIcon } from './icons';

/**
 * Page header: a small eyebrow, a large title, actions on the right.
 *
 * The eyebrow does real work on a low-cognitive-load screen — it says *which
 * slice of time you are looking at* before the eye reaches the heading, so
 * "Calendar" never has to be read as "calendar of what?".
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-base-content/40 mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[2rem] font-extrabold leading-none tracking-tight sm:text-[2.6rem]">
          {title}
        </h1>
        {subtitle ? <p className="text-base-content/55 mt-2 text-sm">{subtitle}</p> : null}
      </div>

      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base-content/40 mb-3 mt-8 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
      {children}
    </h2>
  );
}

/** Soft informational strip. Never used for errors — those get `alert-error`. */
export function Banner({
  icon,
  lead,
  children,
  action,
}: {
  icon: React.ReactNode;
  lead: string;
  children?: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="bg-primary/6 border-primary/12 mb-6 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3">
      <span className="text-primary shrink-0" aria-hidden="true">
        {icon}
      </span>
      <p className="min-w-0 grow text-sm">
        <span className="font-semibold">{lead}</span>{' '}
        <span className="text-base-content/60">{children}</span>
      </p>
      {action ? (
        <Link
          href={action.href}
          className="text-primary inline-flex shrink-0 items-center gap-1 text-sm font-medium hover:underline"
        >
          {action.label}
          <ArrowRightIcon />
        </Link>
      ) : null}
    </div>
  );
}

/** Segmented control. Each option is a real link, so it survives no-JS. */
export function SegmentedNav({
  options,
  current,
}: {
  options: Array<{ value: string; label: string; href: string; icon: React.ReactNode }>;
  current: string;
}) {
  return (
    <div className="bg-base-200 flex items-center gap-1 rounded-xl p-1" role="group">
      {options.map((option) => {
        const active = option.value === current;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={active ? 'true' : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-base-100 text-primary shadow-sm'
                : 'text-base-content/55 hover:text-base-content'
            }`}
          >
            <span aria-hidden="true">{option.icon}</span>
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

const ENERGY_BADGE: Record<string, string> = {
  HIGH: 'badge-secondary',
  MEDIUM: 'badge-info',
  LOW: 'badge-accent',
};

export function EnergyBadge({ energy }: { energy: string }) {
  return (
    <span className={`badge badge-sm badge-soft ${ENERGY_BADGE[energy] ?? ''}`}>
      {energy.toLowerCase()} energy
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority !== 'URGENT' && priority !== 'HIGH') return null;
  return (
    <span
      className={`badge badge-sm badge-soft ${priority === 'URGENT' ? 'badge-error' : 'badge-warning'}`}
    >
      {priority.toLowerCase()}
    </span>
  );
}

/** Consistent empty state — never a bare "no data". */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body items-center py-12 text-center">
        <p className="font-medium">{title}</p>
        {hint ? <p className="text-base-content/50 text-sm">{hint}</p> : null}
      </div>
    </div>
  );
}
