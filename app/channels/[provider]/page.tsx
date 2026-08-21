import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelDefinitions, isChannelId } from "../channel-data";
import { ChannelWorkspace } from "./ChannelWorkspace";

type PageProps = {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ compose?: string; draft?: string }>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { provider } = await params;
  if (!isChannelId(provider)) return { title: "Không tìm thấy kênh | TAHA AI" };
  const channel = channelDefinitions[provider];
  return {
    title: `${channel.name} | TAHA AI`,
    description: channel.description,
  };
}

export default async function ChannelPage({ params, searchParams }: PageProps) {
  const [{ provider }, query] = await Promise.all([params, searchParams]);
  if (!isChannelId(provider)) notFound();
  const openContent = query.compose === "1" || typeof query.draft === "string";
  return <ChannelWorkspace provider={provider} initialTab={openContent ? "content" : undefined} openComposer={query.compose === "1"} />;
}
