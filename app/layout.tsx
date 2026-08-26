import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isViewerRequest } from "../lib/operator-auth";
import "./globals.css";
import "./ui/app-shell.css";
import "./ui/domain.css";

const publicAppUrl = process.env.PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(publicAppUrl),
  title: "TAHA AI — Trung tâm vận hành bán hàng đa kênh",
  description:
    "Quản lý sản phẩm, nội dung AI và lịch đăng Facebook, Zalo, Shopee, TikTok Shop trong một hệ thống.",
  applicationName: "TAHA AI",
  openGraph: {
    type: "website",
    locale: "vi_VN",
    title: "TAHA AI — Vận hành bán hàng đa kênh",
    description: "Google Drive và Sheet đi vào một luồng duyệt, lên lịch và xuất bản đa kênh.",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "TAHA AI — Vận hành bán hàng đa kênh" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TAHA AI — Vận hành bán hàng đa kênh",
    description: "Google Drive và Sheet đi vào một luồng duyệt, lên lịch và xuất bản đa kênh.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  if (!isViewerRequest(new Request(`${protocol}://${host}/`, { headers: requestHeaders }))) notFound();

  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
