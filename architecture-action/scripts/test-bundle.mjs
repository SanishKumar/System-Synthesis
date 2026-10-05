import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

async function run(revision, inputs = {}, fork = false) {
  const runDirectory = mkdtempSync(join(directory, "run-"));
  const output = join(runDirectory, "outputs");
  const summary = join(runDirectory, "summary");
  const eventPath = join(runDirectory, "event.json");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(eventPath, JSON.stringify({
    repository: { full_name: repository },
    pull_request: { number: 1, title: "Consumer smoke test", html_url: `https://github.com/${repository}/pull/1`,
      updated_at: "2026-10-05T00:00:00Z", base: { sha: base },
      head: { sha: revision, repo: { full_name: fork ? "contributor/bundle-consumer" : repository } } },
  }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(GITHUB_|INPUT_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      cwd: consumer,
      env: { ...environment, GITHUB_WORKSPACE: consumer, GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        "INPUT_COMPOSE-PATH": "compose.yaml", "INPUT_POLICY-PATH": ".system-synthesis/policy.json",
        "INPUT_BASE-REVISION": base, "INPUT_HEAD-REVISION": revision,
        "INPUT_OUTPUT-DIRECTORY": `.system-synthesis/${runDirectory.split(/[\\/]/).at(-1)}`,
        ...inputs },
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
