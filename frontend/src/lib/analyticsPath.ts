/**
 * Identifiers that appear in a path and must not leave with it.
 *
 * A review's URL carries its id, and a board's carries its own. Sent as-is, the
 * page path alone would tell a third party which reviews and boards exist here
 * and how often each is opened — information about the people using this
 * product, when the question analytics is here to answer is only whether anyone
 * is finding it.
 *
 * Kept apart from the component that installs the analytics script so it can be
 * run and checked on its own.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Boards are not UUIDs; they are `board-<timestamp>`. */
const BOARD_ID = /board-\d+/gi;

/**
 * Routes whose identifier is a secret rather than merely private.
 *
 * An invitation token grants access to a board. Matching it by shape would be
 * guesswork, so the whole segment after a known route is replaced regardless of
 * what it looks like — the safe direction to be wrong in. Any future route
 * whose path carries a credential belongs here.
 */
const SECRET_SEGMENT = /^\/(invite)\/[^/]+/i;

/**
 * The route a URL belongs to, with identifiers and query removed.
 *
 * The query string is dropped whole rather than filtered: it carries the
 * outcome of a GitHub authorisation and whatever a future link appends, and
 * none of it is traffic information.
 */
export function scrubPath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, "http://local").pathname;
  } catch {
    return "/";
  }
  return pathname
    .replace(SECRET_SEGMENT, "/$1/[token]")
    .replace(UUID, "[id]")
    .replace(BOARD_ID, "[id]");
}

/**
 * The value to report for a page view: the same route, with the origin kept.
 *
 * The origin has to survive. The analytics client forwards `url` onward as an
 * absolute URL — every documented redaction example rebuilds one — and this
 * returned a bare path instead, which is not a shape the client contracts for.
 * Nothing is disclosed by keeping the origin: it is this deployment's own
 * address, which the request already carried.
 */
export function scrubUrl(url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // A relative value, which the client is not expected to produce. Naming a
    // host that was never received would be a worse answer than a partial one.
    return scrubPath(url);
  }
  return `${origin}${scrubPath(url)}`;
}
