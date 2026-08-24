/**
 * Which stored reviews a request is allowed to reach.
 *
 * `architecture_reviews.owner_id` answers "who stored this". Until now that
 * same column has also been answering "who may reach it", because every review
 * is private to the account that stored it and the two questions happen to
 * share an answer. They are not the same question. The moment reachability
 * widens — to the collaborators on a repository — a query written against the
 * first meaning grants or refuses the wrong thing, and nothing about it looks
 * wrong: `owner_id = $2` reads as correct under either reading.
 *
 * A scope names the second question on its own. Nothing here widens anything.
 * The only scope that exists reaches an account's own reviews, so every
 * predicate below still reduces to `owner_id = $n` — the same SQL these
 * queries carried before. What changes is that one place now decides it,
 * instead of ten queries each having decided it separately.
 *
 * Reachability is not authority. This answers which rows a caller can address
 * at all; whether they may then decide one is `reviewEntitlement`'s question,
 * asked against GitHub at the moment it matters.
 */
export type ReviewAccessScope = {
  /**
   * A union with one member. Later reachability arrives as another `kind`, and
   * the exhaustiveness checks below turn every place that has to handle it
   * into a compile error rather than a silent fallthrough.
   */
  readonly kind: "owner";
  /** The account whose own reviews this scope reaches. */
  readonly ownerId: string;
};

/** The reach of an account over the reviews it stored itself. */
export function ownerScope(ownerId: string): ReviewAccessScope {
  return { kind: "owner", ownerId };
}

export interface ReachabilityPredicate {
  /**
   * A SQL condition, ready to drop into a `WHERE` clause.
   *
   * It binds exactly one value and may reference that placeholder more than
   * once. Holding to one parameter is what lets a widened predicate replace a
   * narrow one without renumbering every placeholder around it — and a query
   * whose numbering shifts silently is a query that reads the wrong column.
   */
  readonly sql: string;
  /** The single value the condition binds. */
  readonly parameter: string;
}

/**
 * The condition that restricts a query to the rows this scope reaches.
 *
 * `table` qualifies the column for queries that join, where a bare `owner_id`
 * would be ambiguous.
 */
export function reachability(
  scope: ReviewAccessScope,
  placeholder: number,
  table?: string
): ReachabilityPredicate {
  const column = table ? `${table}.owner_id` : "owner_id";
  switch (scope.kind) {
    case "owner":
      return { sql: `${column} = $${placeholder}`, parameter: scope.ownerId };
    default: {
      const unhandled: never = scope.kind;
      throw new Error(`Unknown review access scope: ${String(unhandled)}`);
    }
  }
}

/**
 * Whether this scope reaches this review.
 *
 * The answer the SQL condition gives, for the in-memory store that runs when
 * no database is configured. The two must agree: a scope that reaches a review
 * in one and not the other means persistence changes who can see what.
 */
export function reaches(
  scope: ReviewAccessScope,
  review: { ownerId: string }
): boolean {
  switch (scope.kind) {
    case "owner":
      return review.ownerId === scope.ownerId;
    default: {
      const unhandled: never = scope.kind;
      throw new Error(`Unknown review access scope: ${String(unhandled)}`);
    }
  }
}
