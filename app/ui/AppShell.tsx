import type { ReactNode } from "react";
import Link from "../SiteLink";
import { AppIcon, type AppIconName } from "./AppIcon";

export type AppNavId =
  | "overview"
  | "products"
  | "content"
  | "calendar"
  | "automation"
  | "connections"
  | "activity"
  | "settings"
  | "guide";

type NavItem = {
  id: AppNavId;
  href: string;
  label: string;
  icon: AppIconName;
};

type AppShellProps = {
  active: AppNavId;
  contextTitle: string;
  children: ReactNode;
  headerActions?: ReactNode;
  noticeCount?: number;
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Vận hành",
    items: [
      { id: "overview", href: "/", label: "Tổng quan", icon: "home" },
      { id: "products", href: "/products", label: "Sản phẩm", icon: "products" },
      { id: "content", href: "/content", label: "Nội dung & Media", icon: "content" },
      { id: "calendar", href: "/calendar", label: "Lịch đăng", icon: "calendar" },
      { id: "automation", href: "/automation", label: "AI Automation", icon: "automation" },
    ],
  },
  {
    label: "Hệ thống",
    items: [
      { id: "connections", href: "/connections", label: "Kênh kết nối", icon: "connections" },
      { id: "activity", href: "/activity", label: "Nhật ký hoạt động", icon: "activity" },
      { id: "settings", href: "/settings", label: "Cài đặt", icon: "settings" },
      { id: "guide", href: "/connections/guide", label: "Hướng dẫn", icon: "help" },
    ],
  },
];

const mobileItems: NavItem[] = [
  { id: "overview", href: "/", label: "Tổng quan", icon: "home" },
  { id: "products", href: "/products", label: "Sản phẩm", icon: "products" },
  { id: "content", href: "/content", label: "Nội dung", icon: "content" },
  { id: "calendar", href: "/calendar", label: "Lịch", icon: "calendar" },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className={compact ? "app-brand is-compact" : "app-brand"} href="/" aria-label="TAHA AI - Tổng quan">
      <span className="app-brand-mark" aria-hidden="true"><i /><b>TA</b></span>
      <span className="app-brand-copy"><strong>TAHA AI</strong><small>AI Commerce Operations</small></span>
    </Link>
  );
}

function NavigationLink({ item, active }: { item: NavItem; active: AppNavId }) {
  const current = item.id === active;
  return (
    <Link
      className={current ? "app-nav-link is-active" : "app-nav-link"}
      href={item.href}
      aria-current={current ? "page" : undefined}
    >
      <AppIcon name={item.icon} size={19} />
      <span>{item.label}</span>
    </Link>
  );
}

export function AppShell({ active, contextTitle, children, headerActions, noticeCount = 0 }: AppShellProps) {
  const secondaryItems = navGroups.flatMap((group) => group.items).filter(
    (item) => !mobileItems.some((mobile) => mobile.id === item.id),
  );

  return (
    <div className="taha-shell">
      <aside className="app-sidebar">
        <Brand />
        <div className="app-sidebar-body">
          {navGroups.map((group) => (
            <section className="app-nav-group" key={group.label} aria-label={group.label}>
              <span className="app-nav-label">{group.label}</span>
              <nav className="app-shell-nav" aria-label={group.label}>
                {group.items.map((item) => <NavigationLink item={item} active={active} key={item.id} />)}
              </nav>
            </section>
          ))}
        </div>
        <div className="app-sidebar-status">
          <span className="app-sidebar-status-icon"><AppIcon name="automation" size={18} /></span>
          <div><strong>Product-first workflow</strong><p>Sheets + Drive → AI → đa kênh</p></div>
          <Link href="/connections/guide" aria-label="Mở hướng dẫn vận hành"><AppIcon name="arrow-right" size={17} /></Link>
        </div>
      </aside>

      <div className="app-stage">
        <header className="app-header">
          <Brand compact />
          <div className="app-header-context"><span>TAHA AI</span><strong>{contextTitle}</strong></div>
          <div className="app-header-actions">
            {headerActions}
            <Link className="app-header-icon" href="/activity" aria-label={`${noticeCount} mục cần chú ý`}>
              <AppIcon name="bell" size={20} />
              {noticeCount > 0 ? <b>{noticeCount > 99 ? "99+" : noticeCount}</b> : null}
            </Link>
            <Link className="app-account" href="/settings" aria-label="Mở cài đặt tài khoản">
              <span>TA</span><div><strong>TaHa Team</strong><small>Quản trị viên</small></div>
            </Link>
          </div>
        </header>

        <main className="app-content">{children}</main>
      </div>

      <nav className="app-mobile-nav" aria-label="Điều hướng trên điện thoại">
        {mobileItems.map((item) => {
          const current = item.id === active;
          return (
            <Link className={current ? "is-active" : ""} href={item.href} aria-current={current ? "page" : undefined} key={item.id}>
              <AppIcon name={item.icon} size={21} /><span>{item.label}</span>
            </Link>
          );
        })}
        <details className="app-mobile-more">
          <summary className={secondaryItems.some((item) => item.id === active) ? "is-active" : ""}>
            <AppIcon name="menu" size={21} /><span>Thêm</span>
          </summary>
          <div className="app-mobile-more-panel">
            <strong>Chức năng khác</strong>
            {secondaryItems.map((item) => <NavigationLink item={item} active={active} key={item.id} />)}
          </div>
        </details>
      </nav>
    </div>
  );
}
