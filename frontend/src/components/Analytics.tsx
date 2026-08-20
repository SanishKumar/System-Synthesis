"use client";

import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import { scrubUrl } from "@/lib/analyticsPath";

/**
 * Traffic only: how many people arrive, from where, and which routes they open.
 *
 * Cookieless, and nothing about a review — its contents, findings, or decisions
 * — is sent anywhere; this component never sees them. It is not identifier-free,
 * though: Vercel derives a visitor hash from the incoming request that lasts a
 * day, so the defensible word is anonymous, not identifierless. Whether a given
 * jurisdiction requires consent is a question for whoever operates a deployment,
 * not something this file can settle.
 *
 * The URL is stripped of review and board identifiers and of its query before it
 * leaves, so the record reads `/reviews/[id]` rather than naming which review
 * somebody opened. The origin is kept deliberately — the client forwards an
 * absolute URL, and a bare path is discarded upstream.
 */
export default function Analytics() {
  return (
    <VercelAnalytics
      beforeSend={(event) => ({ ...event, url: scrubUrl(event.url) })}
    />
  );
}
