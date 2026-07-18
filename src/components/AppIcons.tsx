import type { ReactNode } from "react";

interface AppIconProps {
  className?: string;
}

function IconFrame({
  className,
  children,
}: AppIconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function BrandWaveform({ className }: AppIconProps) {
  return (
    <IconFrame className={className}>
      <path d="M3 12h2l1.2-5 2.1 10 2.1-13 2.2 16 2-12 1.8 8 1.3-4H21" />
    </IconFrame>
  );
}

export function DashboardIcon({ className }: AppIconProps) {
  return (
    <IconFrame className={className}>
      <path d="m3.5 10.5 8.5-7 8.5 7" />
      <path d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6" />
    </IconFrame>
  );
}

export function KeyIcon({ className }: AppIconProps) {
  return (
    <IconFrame className={className}>
      <circle cx="8" cy="12" r="4" />
      <path d="m11 9 8-8M15 5l3 3M13 7l3 3" />
    </IconFrame>
  );
}

export function MenuIcon({ className }: AppIconProps) {
  return (
    <IconFrame className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </IconFrame>
  );
}

export function CloseIcon({ className }: AppIconProps) {
  return (
    <IconFrame className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconFrame>
  );
}

export function SidebarToggleIcon({
  className,
  expanded,
}: AppIconProps & { expanded: boolean }) {
  return (
    <IconFrame className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      {expanded ? <path d="m15 9-3 3 3 3" /> : <path d="m12 9 3 3-3 3" />}
    </IconFrame>
  );
}
