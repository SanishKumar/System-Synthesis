import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// Exercise the shipped bundle in a consumer that has no node_modules. This
// catches entry-point, packaging and process-exit defects unit tests cannot.
let directory;
let consumer;
let bundle;
let base;
let head;
let malformed;
let ambiguous;
let removed;
let renamed;
const repository = "acme/bundle-consumer";
const safe = "services:\n  database:\n    image: postgres:16\n";
const blocking = safe + "    ports: ['5432:5432']\n";

function git(...args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgSign=false",
    "-c", `core.hooksPath=${join(directory, "no-hooks")}`, ...args], {
    cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Bundle Test", GIT_AUTHOR_EMAIL: "bundle@example.invalid",
      GIT_COMMITTER_NAME: "Bundle Test", GIT_COMMITTER_EMAIL: "bundle@example.invalid" },
  }).trim();
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), "system-synthesis-bundle-"));
  consumer = join(directory, "consumer");
  bundle = join(directory, "action", "index.js");
  mkdirSync(consumer);
  mkdirSync(join(directory, "action"));
  for (const name of ["index.js", "package.json"]) {
    copyFileSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)), join(directory, "action", name));
  }
  git("init", "--quiet");
  mkdirSync(join(consumer, ".system-synthesis"));
  writeFileSync(join(consumer, ".system-synthesis", "policy.json"), "{}");
  writeFileSync(join(consumer, "compose.yaml"), safe);
  git("add", ".");
  git("commit", "--quiet", "-m", "Safe architecture");
  base = git("rev-parse", "HEAD");
  writeFileSync(join(consumer, "compose.yaml"), blocking);
  // The PR must not be able to disable the base branch's policy.
  writeFileSync(join(consumer, ".system-synthesis", "policy.json"), '{"failOn":[]}');
  git("add", ".");
  git("commit", "--quiet", "-m", "Expose database and weaken head policy");
  head = git("rev-parse", "HEAD");
  writeFileSync(join(consumer, "compose.yaml"), "services: [unclosed");
  git("add", ".");
  git("commit", "--quiet", "-m", "Malformed input");
  malformed = git("rev-parse", "HEAD");
  git("checkout", "--quiet", head);
  writeFileSync(join(consumer, "docker-compose.yml"), safe);
  git("add", ".");
  git("commit", "--quiet", "-m", "Add a second Compose candidate");
  ambiguous = git("rev-parse", "HEAD");
  git("checkout", "--quiet", base);
  git("rm", "compose.yaml");
  git("commit", "--quiet", "-m", "Remove Compose");
  removed = git("rev-parse", "HEAD");
  git("checkout", "--quiet", base);
  git("mv", "compose.yaml", "docker-compose.yml");
  git("commit", "--quiet", "-m", "Rename Compose");
  renamed = git("rev-parse", "HEAD");
});

after(() => {
  if (directory) {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("system-synthesis-bundle-"));
    rmSync(target, { recursive: true, force: true });
  }
});

function parseOutputs(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[index]);
    if (!match) continue;
    const value = [];
    while (++index < lines.length && lines[index] !== match[2]) value.push(lines[index]);
    values[match[1]] = value.join("\n");
  }
  return values;
}

async function run(revision, inputs = {}, fork = false, options = {}) {
  const runDirectory = mkdtempSync(join(directory, "run-"));
  const output = join(runDirectory, "outputs");
  const summary = join(runDirectory, "summary");
  const eventPath = join(runDirectory, "event.json");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(eventPath, options.rawEvent ?? JSON.stringify({
    repository: { full_name: repository },
    pull_request: { number: 1, title: "Consumer smoke test", html_url: `https://github.com/${repository}/pull/1`,
      updated_at: "2026-10-05T00:00:00Z", base: { sha: options.eventBase || base },
      head: { sha: revision, repo: { full_name: fork ? "contributor/bundle-consumer" : repository } } },
  }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(GITHUB_|INPUT_|ACTIONS_ID_TOKEN_REQUEST_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      cwd: consumer,
      env: { ...environment, GITHUB_WORKSPACE: consumer, GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        "INPUT_COMPOSE-PATH": "compose.yaml", "INPUT_POLICY-PATH": ".system-synthesis/policy.json",
        "INPUT_BASE-REVISION": base, "INPUT_HEAD-REVISION": revision,
        "INPUT_OUTPUT-DIRECTORY": `.system-synthesis/${runDirectory.split(/[\\/]/).at(-1)}`,
        ...inputs, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
    });
    let log = "";
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, log }));
  });
  return { ...result, outputs: parseOutputs(readFileSync(output, "utf8")) };
}

function assertReports(outputs) {
  for (const name of ["json-file", "markdown-file", "sarif-file"]) {
    assert.ok(existsSync(outputs[name]), `${name} report exists`);
  }
  assert.equal(JSON.parse(readFileSync(outputs["sarif-file"], "utf8")).version, "2.1.0");
}

test("standalone consumer passes without ingestion or installed dependencies", async () => {
  assert.equal(existsSync(join(consumer, "node_modules")), false);
  const result = await run(base);
  assert.equal(result.code, 0, result.log);
  assert.equal(result.outputs["exit-code"], "0");
  assert.equal(result.outputs["ingestion-status"], "skipped");
  assertReports(result.outputs);
  assert.match(readFileSync(result.outputs["comment-file"], "utf8"), /system-synthesis-architecture-review/);
});

test("blocking source fails even when the PR weakens its own policy", async () => {
  const result = await run(head);
  assert.equal(result.code, 1, result.log);
  assert.equal(result.outputs["exit-code"], "1");
  assert.ok(Number(result.outputs["blocking-findings"]) > 0);
  assertReports(result.outputs);
});

test("malformed source exits 2 rather than resembling a policy finding", async () => {
  const result = await run(malformed);
  assert.equal(result.outputs["exit-code"], "2");
  assert.equal(result.code, 2, result.log);
  assert.equal(result.outputs.status, "error");
});

test("a missing Compose path fails explicitly", async () => {
  const result = await run(base, { "INPUT_COMPOSE-PATH": "missing.yaml" });
  assert.equal(result.code, 2, result.log);
  assert.equal(result.outputs.status, "error");
});

test("configured ingestion failure retains the deterministic reports", async () => {
  // Invalid credential format fails before making any network request.
  const result = await run(base, {
    "INPUT_INGESTION-URL": "http://127.0.0.1:1/api/review-ingestions/github",
    "INPUT_INGESTION-TOKEN": "invalid-test-token",
  });
  assert.equal(result.code, 2, result.log);
  assert.equal(result.outputs["exit-code"], "2");
  assert.equal(result.outputs["ingestion-status"], "error");
  assertReports(result.outputs);
  assert.equal(result.outputs["comment-file"], undefined);
});

test("fork source still analyzes but cannot upload a browser review", async () => {
  const result = await run(base, {
    "INPUT_INGESTION-URL": "http://127.0.0.1:1/api/review-ingestions/github",
    "INPUT_INGESTION-TOKEN": `ssri_${"x".repeat(43)}`,
  }, true);
  assert.equal(result.code, 0, result.log);
  assert.equal(result.outputs["ingestion-status"], "skipped");
});

const detectedInputs = {
  "INPUT_COMPOSE-PATH": "", "INPUT_BASE-REVISION": "", "INPUT_HEAD-REVISION": "",
};

test("detects the PR pair and Compose path without using the checkout or merge SHA", async () => {
  // The working tree now holds the renamed file; neither it nor GITHUB_SHA is
  // authoritative for this event. Base policy must still block the head change.
  const result = await run(head, detectedInputs, false, { environment: { GITHUB_SHA: base } });
  assert.equal(result.code, 1, result.log);
  assert.equal(result.outputs["compose-path"], "compose.yaml");
  assert.equal(result.outputs["base-revision"], base);
  assert.equal(result.outputs["head-revision"], head);
  const report = JSON.parse(readFileSync(result.outputs["json-file"], "utf8"));
  assert.equal(report.base.revision, base);
  assert.equal(report.head.revision, head);
});

test("detects a deletion from the base instead of reporting no Compose file", async () => {
  const result = await run(removed, detectedInputs);
  assert.equal(result.code, 0, result.log);
  assert.equal(result.outputs["compose-path"], "compose.yaml");
  const report = JSON.parse(readFileSync(result.outputs["json-file"], "utf8"));
  assert.ok(report.diff.stats.removed > 0);
});

test("detects a newly added Compose file from the head", async () => {
  const result = await run(head, detectedInputs, false, { eventBase: removed });
  assert.equal(result.code, 1, result.log);
  assert.equal(result.outputs["base-revision"], removed);
  assert.equal(result.outputs["compose-path"], "compose.yaml");
});

test("refuses ambiguous candidates, including a rename across the two commits", async () => {
  for (const revision of [ambiguous, renamed]) {
    const result = await run(revision, detectedInputs);
    assert.equal(result.code, 2, result.log);
    assert.match(result.log, /Multiple Compose files/);
    assert.match(result.log, /compose.yaml/);
    assert.match(result.log, /docker-compose.yml/);
    assert.equal(result.outputs["json-file"], undefined);
  }
});

test("explicit path and revisions override detection, including outside a PR event", async () => {
  const result = await run(ambiguous, {
    "INPUT_COMPOSE-PATH": "docker-compose.yml",
    "INPUT_BASE-REVISION": `${renamed}~0`, "INPUT_HEAD-REVISION": ambiguous,
  }, false, { environment: { GITHUB_EVENT_NAME: "workflow_dispatch" }, rawEvent: "not JSON" });
  assert.equal(result.code, 0, result.log);
  assert.equal(result.outputs["compose-path"], "docker-compose.yml");
  assert.equal(result.outputs["base-revision"], renamed);
});

test("requires explicit revisions outside pull_request and rejects malformed PR metadata", async () => {
  const nonPr = await run(head, detectedInputs, false,
    { environment: { GITHUB_EVENT_NAME: "pull_request_target" } });
  assert.equal(nonPr.code, 2);
  assert.match(nonPr.log, /base-revision and head-revision/);
  const malformedEvent = await run(head, detectedInputs, false, { rawEvent: "not JSON" });
  assert.equal(malformedEvent.code, 2);
  assert.match(malformedEvent.log, /valid JSON/);
});

test("no candidates and unavailable commits fail with actionable input errors", async () => {
  const noFile = await run(removed, detectedInputs, false, { eventBase: removed });
  assert.equal(noFile.code, 2);
  assert.match(noFile.log, /No standard Compose file/);
  const missingCommit = await run("c".repeat(40), detectedInputs);
  assert.equal(missingCommit.code, 2);
  assert.match(missingCommit.log, /fetch-depth: 0/);
});

test("detected fork reviews still cannot upload when ingestion inputs are present", async () => {
  const result = await run(base, { ...detectedInputs,
    "INPUT_INGESTION-URL": "http://127.0.0.1:1/api/review-ingestions/github",
    "INPUT_INGESTION-TOKEN": `ssri_${"x".repeat(43)}`,
  }, true);
  assert.equal(result.code, 0, result.log);
  assert.equal(result.outputs["head-revision"], base);
  assert.equal(result.outputs["ingestion-status"], "skipped");
});

test("detected inputs and explicit ref aliases ingest the exact PR pair with base policy", async () => {
  const payloads = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "created",
        reviewId: "8f2a1c00-0000-4000-8000-000000000001",
        reviewUrl: "https://example.invalid/reviews/8f2a1c00-0000-4000-8000-000000000001",
        revision: 1, analysisStatus: "fail", blockingFindings: 1, headRevision: head }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const baseInput of ["", `${base}~0`]) {
      const result = await run(head, { ...detectedInputs,
        "INPUT_BASE-REVISION": baseInput,
        "INPUT_INGESTION-URL": `http://127.0.0.1:${server.address().port}/api/review-ingestions/github`,
        "INPUT_INGESTION-TOKEN": `ssri_${"x".repeat(43)}`,
      });
      assert.equal(result.code, 1, result.log);
      assert.equal(result.outputs["ingestion-status"], "created");
      assert.match(readFileSync(result.outputs["comment-file"], "utf8"), /example.invalid\/reviews/);
    }
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.equal(payload.baseRevision, base);
      assert.equal(payload.headRevision, head);
      assert.equal(payload.baseGraph.source.revision, base);
      assert.equal(payload.headGraph.source.revision, head);
      assert.equal(payload.sourcePath, "compose.yaml");
      assert.equal(payload.policy.failOn, undefined);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// --- GitHub OIDC -----------------------------------------------------------

const identityToken = [
  Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ repository, run_id: "5551" })).toString("base64url"),
  Buffer.from("not-a-real-signature").toString("base64url"),
].join(".");

/**
 * Stands in for the two things an OIDC delivery talks to: the endpoint GitHub
 * gives a run to request its identity token from, and the ingestion endpoint.
 */
async function oidcWorld(handleIngestion) {
  const tokenRequests = [];
  const deliveries = [];
  const github = createServer((request, response) => {
    tokenRequests.push({ url: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ value: identityToken }));
  });
  const ingestion = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      deliveries.push({ authorization: request.headers.authorization, payload: JSON.parse(body) });
      const answer = handleIngestion?.() ?? { status: 201, body: { status: "created",
        reviewId: "8f2a1c00-0000-4000-8000-000000000002",
        reviewUrl: "https://example.invalid/reviews/8f2a1c00-0000-4000-8000-000000000002",
        revision: 1, analysisStatus: "pass", blockingFindings: 0, headRevision: base } };
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => ingestion.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${ingestion.address().port}`;
  return {
    tokenRequests, deliveries, origin,
    inputs: { "INPUT_INGESTION-URL": `${origin}/api/review-ingestions/github` },
    environment: {
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${github.address().port}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
      GITHUB_RUN_ID: "5551", GITHUB_ACTOR: "octo-admin",
    },
    close: async () => {
      for (const server of [github, ingestion]) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}

test("an endpoint with no stored token delivers with the run's identity token", async () => {
  const world = await oidcWorld();
  try {
    const result = await run(base, world.inputs, false, { environment: world.environment });
    assert.equal(result.code, 0, result.log);
    assert.equal(result.outputs["ingestion-status"], "created");

    // Asked of GitHub once, as this run, for the origin it is then sent to.
    assert.equal(world.tokenRequests.length, 1);
    assert.equal(world.tokenRequests[0].authorization, "Bearer runtime-request-token");
    assert.equal(
      new URL(world.tokenRequests[0].url, "http://127.0.0.1").searchParams.get("audience"),
      world.origin
    );

    assert.equal(world.deliveries.length, 1);
    assert.equal(world.deliveries[0].authorization, `Bearer ${identityToken}`);
    // What the server holds an identity-token delivery to.
    assert.equal(world.deliveries[0].payload.workflowRun.id, "5551");
    assert.equal(world.deliveries[0].payload.pullRequest.number, 1);
    // Registered as a secret before anything else could print it.
    assert.ok(result.log.includes(`::add-mask::${identityToken}`), result.log);
    assert.match(readFileSync(result.outputs["comment-file"], "utf8"), /example.invalid\/reviews/);
  } finally {
    await world.close();
  }
});

test("a stored token is used alone even when an identity token could be requested", async () => {
  const world = await oidcWorld();
  try {
    const stored = `ssri_${"x".repeat(43)}`;
    const result = await run(base, { ...world.inputs, "INPUT_INGESTION-TOKEN": stored },
      false, { environment: world.environment });
    assert.equal(result.code, 0, result.log);
    assert.equal(world.tokenRequests.length, 0);
    assert.equal(world.deliveries[0].authorization, `Bearer ${stored}`);
  } finally {
    await world.close();
  }
});

test("a fork neither requests an identity token nor delivers", async () => {
  const world = await oidcWorld();
  try {
    const result = await run(base, world.inputs, true, { environment: world.environment });
    assert.equal(result.code, 0, result.log);
    assert.equal(result.outputs["ingestion-status"], "skipped");
    assert.match(result.log, /skipped for a fork pull request/);
    assert.equal(world.tokenRequests.length, 0);
    assert.equal(world.deliveries.length, 0);
  } finally {
    await world.close();
  }
});

test("a job that cannot request an identity token fails and says what to add", async () => {
  const world = await oidcWorld();
  try {
    const result = await run(base, world.inputs, false, { environment: { GITHUB_ACTOR: "octo-admin" } });
    assert.equal(result.code, 2, result.log);
    assert.equal(result.outputs["ingestion-status"], "error");
    assert.match(result.log, /id-token: write/);
    assert.equal(world.deliveries.length, 0);
    // The review itself was still produced.
    assertReports(result.outputs);

    // Half of what GitHub provides is the same as none of it.
    const halfGranted = await run(base, world.inputs, false, { environment: {
      GITHUB_ACTOR: "octo-admin",
      ACTIONS_ID_TOKEN_REQUEST_URL: world.environment.ACTIONS_ID_TOKEN_REQUEST_URL } });
    assert.equal(halfGranted.code, 2, halfGranted.log);
    assert.match(halfGranted.log, /id-token: write/);
    assert.equal(world.tokenRequests.length, 0);
  } finally {
    await world.close();
  }
});

test("a Dependabot run given no credential of either kind keeps its review local", async () => {
  const world = await oidcWorld();
  try {
    const result = await run(base, world.inputs, false,
      { environment: { GITHUB_ACTOR: "dependabot[bot]" } });
    assert.equal(result.code, 0, result.log);
    assert.equal(result.outputs["ingestion-status"], "skipped");
    assert.match(result.log, /neither an ingestion token nor an identity token/);
    assert.equal(world.deliveries.length, 0);
  } finally {
    await world.close();
  }
});

test("a refused identity-token delivery fails with the server's explanation", async () => {
  const world = await oidcWorld(() => ({ status: 403, body: {
    error: "No connection for acme/bundle-consumer accepts GitHub Actions identity tokens.",
    code: "repository_not_connected_for_oidc" } }));
  try {
    const result = await run(base, world.inputs, false, { environment: world.environment });
    assert.equal(result.code, 2, result.log);
    assert.equal(result.outputs["ingestion-status"], "error");
    assert.match(result.log, /HTTP 403: No connection for acme\/bundle-consumer/);
    // Refused, not retried: one delivery, one token.
    assert.equal(world.deliveries.length, 1);
    assert.equal(world.tokenRequests.length, 1);
  } finally {
    await world.close();
  }
});

test("an identity token is never requested for an endpoint it would not be sent to", async () => {
  const world = await oidcWorld();
  try {
    const result = await run(base, { "INPUT_INGESTION-URL": `${world.origin}/somewhere-else` },
      false, { environment: world.environment });
    assert.equal(result.code, 2, result.log);
    assert.match(result.log, /must end exactly with/);
    assert.equal(world.tokenRequests.length, 0);
    assert.equal(world.deliveries.length, 0);
  } finally {
    await world.close();
  }
});
