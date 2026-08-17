"use client";

import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import { scrubPath } from "@/lib/analyticsPath";

/**
 * Traffic only: how many people arrive, from where, and which routes they open.
 *
 * Cookieless, so no consent banner is required and no identifier for the person
 * is created. Nothing about a review — its contents, findings, or decisions —
 * is sent anywhere; this component never sees them. The path is stripped of
 * review and board identifiers before it leaves, so the record says `/reviews/[id]`
 * rather than naming which review somebody opened.
 */
export default function Analytics() {
  return (
    <VercelAnalytics
      beforeSend={(event) => ({ ...event, url: scrubPath(event.url) })}
    />
  );
}
