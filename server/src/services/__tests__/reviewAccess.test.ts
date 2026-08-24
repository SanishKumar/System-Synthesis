import { describe, expect, it } from "vitest";

import { ownerScope, reachability, reaches } from "../reviewAccess.js";

describe("review access scope", () => {
  it("reaches the reviews an account stored and nothing else", () => {
    const scope = ownerScope("owner-1");

    expect(reaches(scope, { ownerId: "owner-1" })).toBe(true);
    expect(reaches(scope, { ownerId: "owner-2" })).toBe(false);
    expect(reaches(scope, { ownerId: "" })).toBe(false);
  });

  it("binds the account the scope describes, not the placeholder it was given", () => {
    // The condition is dropped into a query whose other parameters are numbered
    // around it. Binding the wrong value here would be invisible: the SQL still
    // parses, still filters on owner_id, and filters on somebody else.
    const predicate = reachability(ownerScope("owner-1"), 2);

    expect(predicate.sql).toBe("owner_id = $2");
    expect(predicate.parameter).toBe("owner-1");
  });

  it("places the condition at the placeholder the caller asked for", () => {
    expect(reachability(ownerScope("owner-1"), 1).sql).toBe("owner_id = $1");
    expect(reachability(ownerScope("owner-1"), 7).sql).toBe("owner_id = $7");
  });

  it("qualifies the column so a join cannot read it ambiguously", () => {
    // `listArchitectureReviewEvents` joins events to reviews. An unqualified
    // owner_id there is a query that fails to run at best, and reads the wrong
    // table's column at worst.
    expect(reachability(ownerScope("owner-1"), 2, "r").sql).toBe("r.owner_id = $2");
  });

  it("binds exactly one value, whatever the scope", () => {
    // The contract the repository's placeholder numbering depends on: a widened
    // predicate may reference its placeholder repeatedly, but introducing a
    // second parameter would silently shift every `$n` after it.
    const predicate = reachability(ownerScope("owner-1"), 2);

    expect(typeof predicate.parameter).toBe("string");
    expect(predicate.sql.match(/\$\d+/g)).toEqual(["$2"]);
  });

  it("agrees with itself about who is reached", () => {
    // The SQL condition and the in-memory check are two implementations of one
    // question. They are compared against the same account here because a
    // deployment that switches storage must not switch who can see what.
    const scope = ownerScope("owner-1");

    expect(reachability(scope, 1).parameter).toBe("owner-1");
    expect(reaches(scope, { ownerId: reachability(scope, 1).parameter })).toBe(true);
  });
});
