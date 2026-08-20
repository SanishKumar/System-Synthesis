import { describe, expect, it } from "vitest";
import { scrubPath, scrubUrl } from "../analyticsPath";

describe("scrubPath removes what must not leave with a page view", () => {
  it("replaces a review identifier", () => {
    expect(scrubPath("https://app.example.com/reviews/8f14e45f-ceea-467a-9d2c-1f9b2ac2f0a1")).toBe(
      "/reviews/[id]"
    );
  });

  it("replaces a board identifier, which is not a UUID", () => {
    expect(scrubPath("https://app.example.com/boards/board-1712345678")).toBe("/boards/[id]");
  });

  it("replaces an invitation segment whatever it looks like", () => {
    // The token grants board access, so the segment is replaced by position
    // rather than by shape: guessing at its form is the wrong direction to be
    // wrong in.
    expect(scrubPath("https://app.example.com/invite/n0tAUuidAtAll")).toBe("/invite/[token]");
    expect(scrubPath("https://app.example.com/invite/8f14e45f-ceea-467a-9d2c-1f9b2ac2f0a1")).toBe(
      "/invite/[token]"
    );
  });

  it("drops the query whole, including a GitHub authorisation outcome", () => {
    expect(scrubPath("https://app.example.com/integrations?code=abc123&state=xyz")).toBe(
      "/integrations"
    );
  });

  it("leaves a route that carries no identifier alone", () => {
    expect(scrubPath("https://app.example.com/reviews")).toBe("/reviews");
    expect(scrubPath("https://app.example.com/")).toBe("/");
  });
});

describe("scrubUrl reports a URL of the shape the analytics client requires", () => {
  it("keeps the origin, so the reported value is an absolute URL", () => {
    // A bare path is not what the client sends upstream. Returning one is why
    // no page view was ever recorded.
    const reported = scrubUrl(
      "https://app.example.com/reviews/8f14e45f-ceea-467a-9d2c-1f9b2ac2f0a1"
    );
    expect(reported).toBe("https://app.example.com/reviews/[id]");
    expect(() => new URL(reported)).not.toThrow();
  });

  it("still removes the identifier, the token, and the query", () => {
    expect(scrubUrl("https://app.example.com/invite/secret-token?code=abc")).toBe(
      "https://app.example.com/invite/[token]"
    );
  });

  it("preserves a non-default port", () => {
    expect(scrubUrl("http://localhost:3000/boards/board-17")).toBe(
      "http://localhost:3000/boards/[id]"
    );
  });

  it("falls back to the route alone rather than inventing an origin", () => {
    // Only reachable if the client ever hands over a relative value. Naming a
    // host we did not receive would be a worse answer than an incomplete one.
    expect(scrubUrl("/reviews/8f14e45f-ceea-467a-9d2c-1f9b2ac2f0a1")).toBe("/reviews/[id]");
  });
});
