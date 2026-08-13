/**
 * Inline SVG icons.
 *
 * Inline rather than a package: the CSP forbids external origins, and a handful
 * of paths is cheaper than a dependency. Every icon is `aria-hidden` — the text
 * beside it is the label.
 */
const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

type IconProps = { className?: string };

const size = (className?: string) => className ?? 'size-[18px]';

export const TodayIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <rect x="3" y="5" width="18" height="15" rx="3" />
    <path d="M3 10h18" />
  </svg>
);

export const CalendarIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <rect x="3" y="5" width="18" height="16" rx="3" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const ProjectsIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M10 7h10M10 12h10M10 17h10" />
    <path d="M4 6.5l1.2 1.2L7.5 5.4M4 16.5l1.2 1.2 2.3-2.3" />
    <circle cx="5.2" cy="12" r="1" />
  </svg>
);

export const TasksIcon = ProjectsIcon;

export const ActivityIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M3 12h4l3 8 4-16 3 8h4" />
  </svg>
);

export const ReviewIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M4 19V5M4 19h16" />
    <path d="M8 15v-3M13 15V8M18 15v-5" />
  </svg>
);

export const SettingsIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.5 1.5 0 0 0-2.5 1V21a2 2 0 1 1-4 0v-.2a1.5 1.5 0 0 0-2.5-1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.5 1.5 0 0 0-1-2.5H3a2 2 0 1 1 0-4h.2a1.5 1.5 0 0 0 1-2.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.5 1.5 0 0 0 2.5-1V3a2 2 0 1 1 4 0v.2a1.5 1.5 0 0 0 2.5 1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.5 1.5 0 0 0 1 2.5H21a2 2 0 1 1 0 4h-.2a1.5 1.5 0 0 0-1.7 1.1z" />
  </svg>
);

export const MenuIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-5'}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

/** The "plan my week" wand. */
export const WandIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <path d="M15 4V2M15 10V8M12.5 6h-2M19.5 6h-2" />
    <path d="M13.4 8.6 3 19l2 2L15.4 10.6z" />
  </svg>
);

export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-[18px]'}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
  </svg>
);

export const ArrowRightIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const ColumnsIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </svg>
);

export const ListIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </svg>
);

/** Sits beside the "no shame zone" note. */
export const LeafIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 16-9 0 8-3 13-9 13z" />
    <path d="M4 21c2-6 5-9 9-11" />
  </svg>
);

export const DotsIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-4'}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);

export const XIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const TimerIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l3 2M9.5 2.5h5M12 2.5V5" />
  </svg>
);

export const PencilIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={className ?? 'size-3.5'}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
  </svg>
);

/** Routines: a repeating cycle. */
export const RoutineIcon = ({ className }: IconProps) => (
  <svg {...stroke} className={size(className)}>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 12a8 8 0 0 1-13.7 5.6L4 16" />
    <path d="M20 4v4h-4M4 20v-4h4" />
  </svg>
);

/** Logo mark: a node with branches — planning, not a brain cliché. */
export const LogoMark = ({ className }: IconProps) => (
  <svg {...stroke} strokeWidth={1.6} className={className ?? 'size-5'}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 9V4.5M12 15v4.5M9 12H4.5M15 12h4.5" />
    <circle cx="12" cy="3.2" r="1.2" />
    <circle cx="12" cy="20.8" r="1.2" />
    <circle cx="3.2" cy="12" r="1.2" />
    <circle cx="20.8" cy="12" r="1.2" />
  </svg>
);
