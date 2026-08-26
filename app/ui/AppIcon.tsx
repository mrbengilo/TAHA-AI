import type { SVGProps } from "react";

export type AppIconName =
  | "home"
  | "products"
  | "content"
  | "calendar"
  | "automation"
  | "connections"
  | "activity"
  | "settings"
  | "help"
  | "menu"
  | "bell"
  | "plus"
  | "sync"
  | "search"
  | "arrow-right"
  | "check"
  | "alert"
  | "clock"
  | "image"
  | "publish";

type AppIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: AppIconName;
  size?: number;
};

function IconPath({ name }: { name: AppIconName }) {
  switch (name) {
    case "home":
      return <><path d="m3 10.8 9-7.3 9 7.3" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-7h5v7" /></>;
    case "products":
      return <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="m4 7 8 4 8-4" /><path d="M4 7v10l8 4 8-4V7" /><path d="M12 11v10" /></>;
    case "content":
      return <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.2-4.2 3.2 3.2 2.5-2.5L19 17.5" /></>;
    case "calendar":
      return <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></>;
    case "automation":
      return <><path d="m12 3 1.2 3.2L16.5 7.5l-3.3 1.3L12 12l-1.2-3.2-3.3-1.3 3.3-1.3L12 3Z" /><path d="m18 12 .8 2.2L21 15l-2.2.8L18 18l-.8-2.2L15 15l2.2-.8L18 12Z" /><path d="m6 13 1 2.7 2.7 1L7 17.7 6 20.5l-1-2.8-2.7-1 2.7-1L6 13Z" /></>;
    case "connections":
      return <><path d="M8.5 12.5 6 15a3.5 3.5 0 0 0 5 5l2.5-2.5" /><path d="m15.5 11.5 2.5-2.5a3.5 3.5 0 0 0-5-5L10.5 6.5" /><path d="m8 16 8-8" /></>;
    case "activity":
      return <><path d="M4 19V9M10 19V5M16 19v-7M22 19V3" /><path d="M2 19h20" /></>;
    case "settings":
      return <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.28.35.5.75.6 1 .1.35.13.72.09 1.09H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>;
    case "help":
      return <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 1 1 3.6 2.1c-.9.5-1.4 1-1.4 2.2" /><path d="M12 17h.01" /></>;
    case "menu":
      return <><path d="M4 7h16M4 12h16M4 17h16" /></>;
    case "bell":
      return <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>;
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "sync":
      return <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.5-2L20 9M4 15l2.4 2a7 7 0 0 0 11.5-2" /></>;
    case "search":
      return <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>;
    case "arrow-right":
      return <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>;
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "alert":
      return <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>;
    case "clock":
      return <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>;
    case "image":
      return <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4-4 3 3 3-3 4 4" /></>;
    case "publish":
      return <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 14v5h14v-5" /></>;
  }
}

export function AppIcon({ name, size = 20, className, ...props }: AppIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      <IconPath name={name} />
    </svg>
  );
}
