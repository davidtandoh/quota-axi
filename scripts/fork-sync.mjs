// Runs before dependency installation and in the writer job. Keep this helper
// dependency-free: importing product code here would execute proposed code
// with the publication token. Git object reads are bounded by run().
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const fork = "davidtandoh/quota-axi";
const upstreamRepo = "kunchenguid/quota-axi";
const manifestPath = "fork-sync.json";
const shaPattern = /^[0-9a-f]{40}$/;
const options = {
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
  timeout: 120_000,
  stdio: ["pipe", "pipe", "pipe"],
};

function fail(message) {
  throw new Error(`ForkSyncError: ${message}`);
}
function run(args, extra = {}) {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      ...options,
      ...extra,
    }).trimEnd();
  } catch {
    // Never forward subprocess diagnostics: authenticated Git errors may
    // include request details. The operation name is enough to locate failure.
    fail(
      `git ${args[0]} failed (conflict, missing object, or transport failure)`,
    );
  }
}
function sha(value) {
  if (!shaPattern.test(value ?? "")) fail("expected full immutable commit SHA");
  return value;
}
function ancestor(older, newer, message) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], options);
  } catch {
    fail(message);
  }
}
function paths(from, to) {
  return run(["diff", "--no-renames", "--name-only", "-z", from, to])
    .split("\0")
    .filter(Boolean);
}
function control(path) {
  return (
    path === manifestPath ||
    path.startsWith(".github/") ||
    path === ".gitattributes" ||
    path.endsWith("/.gitattributes") ||
    path === ".gitmodules" ||
    path === ".no-mistakes.yaml" ||
    path === "scripts/fork-sync.mjs"
  );
}
function loadManifest(base) {
  if (!run(["ls-tree", base, "--", manifestPath]).startsWith("100644 blob "))
    fail("manifest must be a regular tracked file");
  let manifest;
  try {
    manifest = JSON.parse(run(["show", `${base}:${manifestPath}`]));
  } catch {
    fail("invalid manifest JSON");
  }
  if (
    manifest.version !== 1 ||
    manifest.upstream?.repository !== upstreamRepo ||
    manifest.upstream?.branch !== "main" ||
    !Array.isArray(manifest.patches) ||
    manifest.patches.length === 0
  )
    fail("invalid manifest contract");
  sha(manifest.upstream.commit);
  const owned = new Set([manifestPath]);
  const ids = new Set();
  for (const patch of manifest.patches) {
    if (
      typeof patch.id !== "string" ||
      !/^[a-z0-9-]+$/.test(patch.id) ||
      ids.has(patch.id) ||
      !Array.isArray(patch.paths) ||
      patch.paths.length === 0
    )
      fail("invalid fork patch record");
    ids.add(patch.id);
    ancestor(sha(patch.anchor), base, `missing fork patch: ${patch.id}`);
    for (const path of patch.paths) {
      if (
        typeof path !== "string" ||
        !/^[a-zA-Z0-9._/-]+$/.test(path) ||
        path.startsWith("/") ||
        path
          .split("/")
          .some((part) => part === ".." || part === "." || part === "") ||
        owned.has(path)
      )
        fail("invalid or duplicate owned path");
      owned.add(path);
    }
  }
  return { manifest, owned };
}
function prepare(base, upstream, expectedHead, dryRun) {
  sha(base);
  sha(upstream);
  if (expectedHead) sha(expectedHead);
  const { manifest, owned } = loadManifest(base);
  const pin = manifest.upstream.commit;
  ancestor(pin, base, "pinned upstream missing from fork history");
  ancestor(pin, upstream, "upstream history drift");
  for (const path of paths(pin, base)) {
    if (!owned.has(path)) fail(`unregistered fork path: ${path}`);
  }
  for (const path of paths(pin, upstream)) {
    if (control(path)) fail(`control-file drift: ${path}`);
    if (owned.has(path)) fail(`fork-owned path overlap: ${path}`);
  }
  if (dryRun)
    return {
      base,
      upstream,
      dryRun: true,
      writes: [
        "local Git objects",
        "temporary Git index under .tmp-cache (removed)",
      ],
    };
  if (pin === upstream) {
    if (expectedHead && expectedHead !== base) fail("validated head mismatch");
    return { base, upstream, head: base, changed: false };
  }
  // Git merges objects without checking out or executing the candidate tree.
  const tree = sha(run(["merge-tree", "--write-tree", base, upstream]));
  mkdirSync(".tmp-cache", { recursive: true });
  const temp = mkdtempSync(".tmp-cache/fork-sync-");
  let mergedTree;
  try {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(process.cwd(), temp, "index"),
    };
    run(["read-tree", tree], { env });
    manifest.upstream.commit = upstream;
    const blob = run(["hash-object", "-w", "--stdin"], {
      input: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    run(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},${manifestPath}`,
      ],
      { env },
    );
    mergedTree = run(["write-tree"], { env });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  for (const path of paths(base, mergedTree)) {
    if (path !== manifestPath && owned.has(path))
      fail(`fork patch changed after merge: ${path}`);
  }
  for (const path of paths(upstream, mergedTree)) {
    if (!owned.has(path)) fail(`merged upstream content drift: ${path}`);
  }
  const timestamp =
    Math.max(
      ...[base, upstream].map((ref) =>
        Number(run(["show", "-s", "--format=%ct", ref])),
      ),
    ) + 1;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_COMMITTER_EMAIL:
      "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_AUTHOR_DATE: `${timestamp} +0000`,
    GIT_COMMITTER_DATE: `${timestamp} +0000`,
  };
  const head = sha(
    run(["commit-tree", mergedTree, "-p", base, "-p", upstream], {
      env,
      input: `chore(sync): Merge upstream ${upstream.slice(0, 12)}\n\nPreserve registered fork patches and advance the upstream pin.\n`,
    }),
  );
  if (expectedHead && head !== expectedHead) fail("validated head mismatch");
  return { base, upstream, head, changed: true };
}
function remoteHead(repository, branch) {
  const output = run([
    "ls-remote",
    "--heads",
    `https://github.com/${repository}.git`,
    `refs/heads/${branch}`,
  ]);
  if (!output) return null;
  const [commit, ref] = output.split(/\s+/);
  if (ref !== `refs/heads/${branch}`) fail("unexpected remote ref");
  return sha(commit);
}
function fetchMain(repository) {
  run([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    `https://github.com/${repository}.git`,
    "refs/heads/main",
  ]);
}
async function api(path, method = "GET", body) {
  const token = process.env.GH_TOKEN;
  if (!token) fail("publication token missing");
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${fork}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("GitHub API transport failure");
  }
  if (!response.ok)
    fail(`GitHub API ${method} failed with HTTP ${response.status}`);
  return response.json();
}
function verifyRemote(base, upstream) {
  if (remoteHead(fork, "main") !== base)
    fail("fork main moved; rerun discovery");
  if (remoteHead(upstreamRepo, "main") !== upstream)
    fail("upstream moved; rerun discovery");
}
async function publish(result) {
  const { base, upstream, head, changed } = result;
  if (!changed) return result;
  const metadata = await api("");
  if (
    metadata.full_name !== fork ||
    metadata.parent?.full_name !== upstreamRepo ||
    metadata.default_branch !== "main" ||
    !metadata.allow_merge_commit
  )
    fail("repository metadata drift");
  const branch = `sync/upstream-main-${base}-${upstream}`;
  const pulls = await api("/pulls?state=open&base=main&per_page=100");
  if (!Array.isArray(pulls) || pulls.length >= 100)
    fail("cannot bound existing PR inventory");
  const existing = pulls.find(
    (pr) => pr.head?.ref === branch && pr.head?.repo?.full_name === fork,
  );
  if (
    pulls.some(
      (pr) =>
        pr.head?.repo?.full_name === fork &&
        pr.head.ref.startsWith("sync/upstream-main-") &&
        pr !== existing,
    )
  )
    fail("another sync PR is open; review or close it first");
  verifyRemote(base, upstream);
  const remote = remoteHead(fork, branch);
  if (remote && remote !== head) fail("sync branch drift; never overwrite it");
  if (existing) {
    if (
      existing.head.sha !== head ||
      remote !== head ||
      existing.draft ||
      existing.user?.login !== "github-actions[bot]"
    )
      fail("existing sync PR drift");
    return { ...result, url: existing.html_url };
  }
  // Only this explicit sync ref can be written. GITHUB_TOKEN itself is scoped
  // to a repository, not a branch; main protection is a separate prerequisite.
  if (!remote) {
    const credential = Buffer.from(
      `x-access-token:${process.env.GH_TOKEN}`,
    ).toString("base64");
    run(
      [
        "push",
        `https://github.com/${fork}.git`,
        `${head}:refs/heads/${branch}`,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
        },
      },
    );
  }
  verifyRemote(base, upstream);
  if (remoteHead(fork, branch) !== head) fail("published branch drift");
  const runUrl = `https://github.com/${fork}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const pr = await api("/pulls", "POST", {
    base: "main",
    head: branch,
    draft: false,
    title: `chore(sync): Merge upstream ${upstream.slice(0, 12)}`,
    body: `## Problem and change\n\nMerge pinned upstream main into the fork without replaying or dropping fork commits.\n\n- Fork base: \`${base}\`\n- Upstream: \`${upstream}\`\n- Validated merge: \`${head}\`\n\n## Verification\n\nThe normal reusable CI passed before publication: [workflow run](${runUrl}). Approve the bot-created PR workflows and require the normal CI checks on the current PR head before merging.\n\n## Risks and rollback\n\nNo release or install has run. Review upstream behavior despite the passing synthetic tests. Use **Create a merge commit**, never squash or rebase. Follow [the update and rollback procedure](docs/fork-sync.md). No automatic merge is enabled.\n`,
  });
  if (
    pr.draft ||
    pr.head?.sha !== head ||
    pr.base?.ref !== "main" ||
    typeof pr.html_url !== "string"
  )
    fail("created PR verification failed");
  return { ...result, url: pr.html_url };
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      upstream: { type: "string" },
      head: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const [mode] = positionals;
  if (
    positionals.length !== 1 ||
    !["discover", "prepare", "publish"].includes(mode)
  )
    fail(
      "usage: fork-sync.mjs discover|prepare|publish --base SHA [--upstream SHA --head SHA] [--dry-run]",
    );
  const base = sha(values.base);
  if (
    run(["rev-parse", "HEAD"]) !== base ||
    run(["status", "--porcelain", "--untracked-files=no"])
  )
    fail("checkout must be clean at the trusted base");
  let upstream = values.upstream;
  if (mode !== "prepare") {
    if (
      process.env.GITHUB_REPOSITORY !== fork ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_SHA !== base ||
      !["schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)
    )
      fail("trusted default-branch run required");
    if (values["dry-run"])
      fail(
        "use prepare --dry-run with local immutable refs; no network mutation",
      );
    if (
      mode === "publish" &&
      (!values.head ||
        !upstream ||
        !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ""))
    )
      fail("validated inputs required");
    upstream ??= remoteHead(upstreamRepo, "main");
    sha(upstream);
    fetchMain(upstreamRepo);
    verifyRemote(base, upstream);
  }
  const result = prepare(base, sha(upstream), values.head, values["dry-run"]);
  console.log(
    JSON.stringify(mode === "publish" ? await publish(result) : result),
  );
} catch (error) {
  console.error(
    error.message?.startsWith("ForkSyncError:")
      ? error.message
      : "ForkSyncError: invalid arguments or unexpected failure",
  );
  process.exitCode = 1;
}
