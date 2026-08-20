import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const publicAppUrl = process.env.PUBLIC_APP_URL || "http://localhost:3000";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
