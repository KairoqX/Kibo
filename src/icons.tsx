/** Small inline vector icons (stroke = currentColor). Real SVG, so they stay crisp at any scale. */
import type { ReactNode } from "react";

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
  );
}

export const IconGrid = ({ size }: { size?: number }) => (
  <Svg size={size}><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></Svg>
);
export const IconMinus = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 12h12" /></Svg>;
export const IconClock = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const IconKeys = ({ size }: { size?: number }) => (
  <Svg size={size}><rect x="2.5" y="6.5" width="19" height="11" rx="3" /><path d="M6.5 10.5h.01M10 10.5h.01M13.5 10.5h.01M17 10.5h.01M7.5 14h9" /></Svg>
);
export const IconFlame = ({ size }: { size?: number }) => (
  <Svg size={size}><path d="M12 3c.5 3-2 4.5-3.5 7A6 6 0 0 0 12 21a6 6 0 0 0 5-9c-1 1-2 1.5-3 1 .5-3-.5-7-2-10z" /></Svg>
);
export const IconSpark = ({ size }: { size?: number }) => (
  <Svg size={size}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></Svg>
);
export const IconStar = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z" /></Svg>;
export const IconLock = ({ size }: { size?: number }) => <Svg size={size}><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Svg>;
export const IconArrow = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const IconActivity = ({ size }: { size?: number }) => <Svg size={size}><path d="M3 12h4l2.5-6 5 12 2.5-6H21" /></Svg>;
export const IconChip = IconActivity;

/** Tiny flat version of Kibo's head (same palette as the character) for the sidebar and brand. */
export function KiboMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect x="2" y="7" width="36" height="28" rx="12" fill="#E8F0FF" />
      <rect x="6" y="11" width="28" height="19" rx="8" fill="#0F172A" />
      <ellipse cx="14.5" cy="19.5" rx="2.8" ry="4" fill="#4DD0E1" /><ellipse cx="25.5" cy="19.5" rx="2.8" ry="4" fill="#4DD0E1" />
      <path d="M16.5 25.6q3.5 2.6 7 0" fill="none" stroke="#4DD0E1" strokeWidth="1.6" strokeLinecap="round" />
      <ellipse cx="9.8" cy="25" rx="2" ry="1.2" fill="#FF8FB1" /><ellipse cx="30.2" cy="25" rx="2" ry="1.2" fill="#FF8FB1" />
      <rect x="19" y="2.2" width="2" height="6" rx="1" fill="#C6D2EB" /><circle cx="20" cy="2.8" r="2.2" fill="#4DD0E1" />
    </svg>
  );
}
