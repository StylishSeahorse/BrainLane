export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {action}
      </div>
      {subtitle ? <p className="text-base-content/60 mt-1 text-sm">{subtitle}</p> : null}
    </header>
  );
}

/** Small caps section divider. Keeps long pages scannable without heavy chrome. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base-content/50 mb-2 mt-8 text-xs font-bold uppercase tracking-wider">
      {children}
    </h2>
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
    <span className={`badge badge-sm badge-soft ${priority === 'URGENT' ? 'badge-error' : 'badge-warning'}`}>
      {priority.toLowerCase()}
    </span>
  );
}
