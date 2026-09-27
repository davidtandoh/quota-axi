import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/fork-sync.mjs");
const dirs: string[] = [];
function fixture() {
  mkdirSync(join(root, ".tmp-cache"), { recursive: true });
  const dir = mkdtempSync(join(root, ".tmp-cache/fork-sync-test-"));
  dirs.push(dir);
  const home = join(dir, "home");
  mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  function commit(path: string, value: string) {
    writeFileSync(join(dir, path), value);
    git("add", "--", path);
    git("commit", "-qm", "test: Update fixture");
    return git("rev-parse", "HEAD");
  }
  const pin = commit("shared.txt", "base\n");
  const anchor = commit("kiro.txt", "fork implementation\n");
  const manifest = {
    version: 1,
    upstream: {
      repository: "kunchenguid/quota-axi",
      branch: "main",
      commit: pin,
    },
    patches: [{ id: "kiro", anchor, paths: ["kiro.txt"] }],
  };
  const base = commit("fork-sync.json", JSON.stringify(manifest));
  git("checkout", "-q", "--detach", pin);
  const upstream = commit("upstream.txt", "new upstream feature\n");
  git("checkout", "-q", "--detach", base);
  const run = (...extra: string[]) =>
    spawnSync(
      process.execPath,
      [script, "prepare", "--base", base, "--upstream", upstream, ...extra],
      { cwd: dir, env, encoding: "utf8" },
    );
  return { dir, env, git, commit, pin, anchor, base, upstream, manifest, run };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("fork sync candidate", () => {
  it("creates a deterministic two-parent merge while preserving fork code and advancing only the pin", () => {
    const f = fixture();
    const first = f.run();
    expect(first.status, first.stderr).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result.changed).toBe(true);
    expect(f.git("show", "-s", "--format=%P", result.head)).toBe(
      `${f.base} ${f.upstream}`,
    );
    expect(f.git("show", `${result.head}:kiro.txt`)).toBe(
      "fork implementation",
    );
    expect(f.git("show", `${result.head}:upstream.txt`)).toBe(
      "new upstream feature",
    );
    expect(JSON.parse(f.git("show", `${result.head}:fork-sync.json`))).toEqual({
      ...f.manifest,
      upstream: { ...f.manifest.upstream, commit: f.upstream },
    });
    expect(JSON.parse(f.run().stdout).head).toBe(result.head);
    expect(f.git("rev-parse", "HEAD")).toBe(f.base);
    expect(f.git("status", "--porcelain", "--untracked-files=no")).toBe("");
  });
  it("returns a no-op when upstream equals the pin", () => {
    const f = fixture();
    const result = f.run("--upstream", f.pin);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      changed: false,
      head: f.base,
    });
  });
  it("refuses non-fast-forward upstream history", () => {
    const f = fixture();
    f.git("checkout", "-q", "--orphan", "rewritten");
    f.git("rm", "-q", "-rf", ".");
    const other = f.commit("other.txt", "unrelated");
    f.git("checkout", "-q", "--detach", f.base);
    expect(f.run("--upstream", other).stderr).toContain(
      "upstream history drift",
    );
  });
  it("refuses upstream edits to a fork-owned path even if Git could merge them", () => {
    const f = fixture();
    f.git("checkout", "-q", "--detach", f.upstream);
    const changed = f.commit("kiro.txt", "upstream replacement\n");
    f.git("checkout", "-q", "--detach", f.base);
    const result = f.run("--upstream", changed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fork-owned path overlap");
  });
  it("refuses unregistered fork changes", () => {
    const f = fixture();
    const changed = f.commit("unowned.txt", "unregistered\n");
    expect(f.run("--base", changed).stderr).toContain("unregistered fork path");
  });
  it("refuses a missing fork patch anchor", () => {
    const f = fixture();
    f.manifest.patches[0].anchor = f.upstream;
    const changed = f.commit("fork-sync.json", JSON.stringify(f.manifest));
    expect(f.run("--base", changed).stderr).toContain("missing fork patch");
  });
  it.each([
    ".gitattributes",
    ".github/workflows/hostile.yml",
    "fork-sync.json",
  ])("refuses upstream control-file drift: %s", (path) => {
    const f = fixture();
    f.git("checkout", "-q", "--detach", f.upstream);
    mkdirSync(join(f.dir, ".github/workflows"), { recursive: true });
    const changed = f.commit(path, "hostile\n");
    f.git("checkout", "-q", "--detach", f.base);
    expect(f.run("--upstream", changed).stderr).toContain("control-file drift");
  });
  it("refuses a mismatched validated head", () => {
    const f = fixture();
    expect(f.run("--head", f.base).stderr).toContain("validated head mismatch");
  });
  it("refuses a validated head mismatch on a no-op", () => {
    const f = fixture();
    expect(f.run("--upstream", f.pin, "--head", f.upstream).stderr).toContain(
      "validated head mismatch",
    );
  });
  it("refuses an update that would silently retain a previous rollback", () => {
    const f = fixture();
    const head = JSON.parse(f.run().stdout).head;
    f.git("checkout", "-q", "--detach", head);
    f.git("revert", "--no-edit", "-m", "1", head);
    const rollback = f.git("rev-parse", "HEAD");
    expect(f.run("--base", rollback).stderr).toContain(
      "merged upstream content drift",
    );
  });
  it("refuses directory-file merge conflicts without modifying the checkout", () => {
    const f = fixture();
    f.git("checkout", "-q", "--detach", f.upstream);
    mkdirSync(join(f.dir, "kiro.txt"));
    const upstream = f.commit("kiro.txt/child", "directory collision\n");
    f.git("checkout", "-q", "--detach", f.base);
    const result = f.run("--upstream", upstream);
    expect(result.stderr).toContain("git merge-tree failed");
    expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  });
  it("rejects invalid refs before invoking Git", () => {
    const f = fixture();
    expect(f.run("--base", "--upload-pack=evil").status).not.toBe(0);
  });
  it("dry run does not create a merge object or change the index", () => {
    const f = fixture();
    const before = f.git("count-objects", "-v");
    expect(f.run("--dry-run").status).toBe(0);
    expect(f.git("count-objects", "-v")).toBe(before);
    expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  });
});

// All publication I/O stays in this synthetic repository. The shim refuses
// unknown network calls rather than falling through to a live endpoint.
function publicationFixture() {
  const f = fixture();
  const head = JSON.parse(f.run().stdout).head;
  const stateFile = join(f.dir, "remote-state.json");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(f.dir, "bin");
  mkdirSync(bin);
  const state: any = {
    base: f.base,
    upstream: f.upstream,
    head,
    branchHead: null,
    pulls: [],
    writes: [],
    apiFailure: false,
    pushFailure: false,
  };
  const gitShim = join(bin, "git");
  writeFileSync(
    gitShim,
    `#!${process.execPath}
import fs from 'node:fs';
import cp from 'node:child_process';
const file = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '-c') args.splice(0, 2);
if (args[0] === 'ls-remote') {
  const ref = args.at(-1);
  const commit = ref === 'refs/heads/main' ? (args[2].includes('kunchenguid') ? state.upstream : state.base) : state.branchHead;
  if (commit) process.stdout.write(commit + '\\t' + ref + '\\n');
} else if (args[0] === 'fetch') {
  // All fixture objects already exist; never use the network.
} else if (args[0] === 'push') {
  state.writes.push({kind: 'push', args});
  fs.writeFileSync(file, JSON.stringify(state));
  if (state.pushFailure) { process.stderr.write(process.env.GH_TOKEN); process.exit(1); }
  state.branchHead = args.at(-1).split(':')[0];
  if (state.moveAfterPush) state.base = state.upstream;
  fs.writeFileSync(file, JSON.stringify(state));
} else {
  const result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}
`,
  );
  chmodSync(gitShim, 0o700);
  const apiShim = join(f.dir, "api-shim.mjs");
  writeFileSync(
    apiShim,
    `
import fs from 'node:fs';
const file = ${JSON.stringify(stateFile)};
globalThis.fetch = async (url, options) => {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (url === 'https://api.github.com/repos/davidtandoh/quota-axi') return Response.json({full_name:'davidtandoh/quota-axi', parent:{full_name:'kunchenguid/quota-axi'}, default_branch:'main', allow_merge_commit:true});
  if (url.endsWith('/pulls?state=open&base=main&per_page=100')) return Response.json(state.pulls);
  if (url.endsWith('/pulls') && options.method === 'POST') {
    const body = JSON.parse(options.body);
    state.writes.push({kind:'pr', body});
    if (state.apiFailure) { fs.writeFileSync(file, JSON.stringify(state)); return new Response('secret response body', {status:403}); }
    const pr = {head:{sha:state.head,ref:body.head,repo:{full_name:'davidtandoh/quota-axi'}}, base:{ref:'main'}, draft:false, user:{login:'github-actions[bot]'}, html_url:'https://example.invalid/synthetic-pull'};
    state.pulls.push(pr);
    fs.writeFileSync(file, JSON.stringify(state));
    return Response.json(pr);
  }
  throw new Error('Unexpected API request');
};
`,
  );
  function save() {
    writeFileSync(stateFile, JSON.stringify(state));
  }
  function read() {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  }
  function publish(extraEnv: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        apiShim,
        script,
        "publish",
        "--base",
        f.base,
        "--upstream",
        f.upstream,
        "--head",
        head,
      ],
      {
        cwd: f.dir,
        encoding: "utf8",
        env: {
          ...f.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: "synthetic-token-never-print",
          GITHUB_REPOSITORY: "davidtandoh/quota-axi",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: f.base,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_RUN_ID: "123",
          ...extraEnv,
        },
      },
    );
  }
  save();
  return { ...f, head, state, save, read, publish };
}

describe("fork sync publication", () => {
  it("publishes only a deterministic sync branch and reuses the exact open PR", () => {
    const f = publicationFixture();
    const first = f.publish();
    expect(first.status, first.stderr).toBe(0);
    expect(f.read().writes.map((entry: any) => entry.kind)).toEqual([
      "push",
      "pr",
    ]);
    expect(f.read().writes[0].args).toEqual([
      "push",
      "https://github.com/davidtandoh/quota-axi.git",
      `${f.head}:refs/heads/sync/upstream-main-${f.base}-${f.upstream}`,
    ]);
    expect(f.read().writes[1].body).toMatchObject({
      base: "main",
      draft: false,
    });
    expect(f.publish().status).toBe(0);
    expect(f.read().writes).toHaveLength(2);
    expect(first.stdout + first.stderr).not.toContain("synthetic-token");
  });
  it.each(["base", "upstream", "branchHead"])(
    "refuses remote %s drift before writing",
    (field) => {
      const f = publicationFixture();
      f.state[field] = "a".repeat(40);
      f.save();
      expect(f.publish().status).not.toBe(0);
      expect(f.read().writes).toEqual([]);
    },
  );
  it("rejects non-default branch runs before touching publication", () => {
    const f = publicationFixture();
    expect(f.publish({ GITHUB_REF: "refs/heads/untrusted" }).stderr).toContain(
      "trusted default-branch run required",
    );
    expect(f.read().writes).toEqual([]);
  });
  it("recovers a pushed branch after PR creation fails without pushing again", () => {
    const f = publicationFixture();
    f.state.apiFailure = true;
    f.save();
    const first = f.publish();
    expect(first.stderr).toContain("HTTP 403");
    expect(first.stderr).not.toContain("secret response");
    Object.assign(f.state, f.read(), { apiFailure: false });
    f.save();
    expect(f.publish().status).toBe(0);
    expect(f.read().writes.map((entry: any) => entry.kind)).toEqual([
      "push",
      "pr",
      "pr",
    ]);
  });
  it("does not create a PR if main moves during push", () => {
    const f = publicationFixture();
    f.state.moveAfterPush = true;
    f.save();
    expect(f.publish().stderr).toContain("fork main moved");
    expect(f.read().writes.map((entry: any) => entry.kind)).toEqual(["push"]);
  });
  it("does not expose authenticated Git diagnostics", () => {
    const f = publicationFixture();
    f.state.pushFailure = true;
    f.save();
    const result = f.publish();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("synthetic-token");
  });
});

describe("fork sync workflow trust boundaries", () => {
  const workflow = (name: string): any =>
    load(readFileSync(join(root, ".github/workflows", name), "utf8"));
  it("isolates publication from read-only discovery and the normal reusable CI", () => {
    const sync = workflow("fork-sync.yml");
    expect(Object.keys(sync.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    expect(sync.permissions).toEqual({ contents: "read" });
    expect(sync.jobs.validate.uses).toBe("./.github/workflows/ci.yml");
    expect(sync.jobs.publish.needs).toEqual(["discover", "validate"]);
    expect(sync.jobs.publish.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(sync.jobs.validate.secrets).toBeUndefined();
    expect(
      sync.jobs.publish.steps.flatMap((step: any) =>
        step.uses ? [step.uses] : [],
      ),
    ).toEqual(["actions/checkout@v4", "actions/setup-node@v6"]);
  });
  it("runs CI without stored credentials or write permission", () => {
    const ci = workflow("ci.yml");
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.on.workflow_call.inputs["sync-head"].required).toBe(true);
    expect(ci.jobs["build-and-test"].steps[0].with["persist-credentials"]).toBe(
      false,
    );
  });
});
