import type { Metadata } from "next";
import { ChannelHub } from "./ChannelHub";

export const metadata: Metadata = {
  title: "Quản lý từng kênh | TAHA AI",
  description: "Theo dõi riêng hình ảnh, bài viết, lịch và trạng thái xuất bản của từng kênh.",
};

export const dynamic = "force-dynamic";

export default function ChannelsPage() {
  return <ChannelHub />;
}
