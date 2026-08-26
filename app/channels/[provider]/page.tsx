import type { Metadata } from "next";
import Link from "../../SiteLink";
import { notFound } from "next/navigation";
import { AppIcon } from "../../ui/AppIcon";
import { AppShell } from "../../ui/AppShell";
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
  const channel = channelDefinitions[provider];
  const openContent = query.compose === "1" || typeof query.draft === "string";
  return (
    <AppShell
      active="connections"
      contextTitle={channel.name}
      headerActions={<Link className="ui-button" href="/channels"><AppIcon name="arrow-right" size={17} /> Tất cả connector</Link>}
    >
      <ChannelWorkspace provider={provider} initialTab={openContent ? "content" : undefined} openComposer={query.compose === "1"} />
    </AppShell>
  );
}
