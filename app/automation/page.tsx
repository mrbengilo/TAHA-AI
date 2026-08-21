import Link from "../SiteLink";
import "../dashboard/dashboard.css";
import "./automation.css";
import AutomationCenter from "./AutomationCenter";

function RobotMark() {
  return <span className="dash-robot" aria-hidden="true"><i /><b>TA</b></span>;
}

function NavIcon({ children }: { children: React.ReactNode }) {
  return <span className="dash-nav-icon" aria-hidden="true">{children}</span>;
}

export const dynamic = "force-dynamic";

export default function AutomationPage() {
  return (
    <div className="dash-shell automation-shell">
      <aside className="dash-sidebar">
        <Link className="dash-brand" href="/" aria-label="TAHA AI - Tổng quan"><RobotMark /><strong>TAHA-AI</strong></Link>
        <nav className="dash-nav" aria-label="Điều hướng chính">
          <Link href="/"><NavIcon>⌂</NavIcon>Tổng quan</Link>
          <Link href="/channels"><NavIcon>⌁</NavIcon>Kênh tích hợp</Link>
          <Link className="is-active" href="/automation" aria-current="page"><NavIcon>✥</NavIcon>AI Automation</Link>
          <Link href="/channels?view=schedules"><NavIcon>▣</NavIcon>Lịch đăng bài</Link>
          <Link href="/channels/google_sheets"><NavIcon>▤</NavIcon>Sản phẩm</Link>
          <Link href="/channels/google_drive"><NavIcon>▧</NavIcon>Nội dung & Media</Link>
          <Link href="/connections"><NavIcon>⚙</NavIcon>Cài đặt hệ thống</Link>
        </nav>
        <div className="dash-plan-card">
          <strong>Quy trình SKU</strong>
          <span>Sheets → Drive → AI → Lịch đăng</span>
          <div className="dash-plan-bar"><i style={{ width: "75%" }} /></div>
          <Link href="/connections/guide">Xem hướng dẫn kết nối</Link>
        </div>
      </aside>
      <main className="dash-main automation-main">
        <header className="dash-header">
          <span className="dash-menu" aria-hidden="true">☰</span>
          <div className="dash-header-actions">
            <Link className="dash-create" href="/channels/google_sheets">＋ Đồng bộ sản phẩm</Link>
            <Link className="dash-team" href="/connections"><span>TA</span><b>TAHA Team</b></Link>
          </div>
        </header>
        <AutomationCenter />
      </main>
    </div>
  );
}
