import type { AnchorHTMLAttributes } from "react";

type SiteLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};

/**
 * Internal navigation deliberately uses native anchors.
 *
 * Vinext's current next/link compatibility runtime can throw while setting up
 * RSC prefetching, which leaves otherwise valid links unable to navigate.
 * Native anchors preserve the same markup and styling while letting the
 * browser perform a reliable document navigation.
 */
export default function SiteLink({ href, children, ...props }: SiteLinkProps) {
  return <a href={href} {...props}>{children}</a>;
}
