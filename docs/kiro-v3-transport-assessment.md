# Kiro V3 quota transport assessment

Assessment updated: 2026-09-26. Target: `kiro-cli --v3` (ACP
`--agent-engine v3`). Installed version: Kiro CLI 2.24.1.

## Current result

quota-axi now collects Kiro credits by default, behind a fail-closed idle
preflight. The earlier task-coexistence blocker is handled by not launching
Kiro at all unless Kiro is provably idle, because task-root isolation does not
work on 2.24.1.

```text
idle preflight ──idle──> kiro-cli acp --agent-engine v3 --auth-method cli
  │                         initialize + _kiro/account/getUsage only
  │                         -> credits window, credits.remaining
  └─busy or unsure──> no launch; unavailable with kiro_busy_* reason
```

Takeaway: a quota read cannot rewrite a live Kiro task's status, because the
read never starts while any Kiro process runs or any task is active.

| Question                                             | 2.24.1 answer                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Does `getUsage` still work without a session?        | Yes. 61.22 of 2,000 credits, reset `2026-10-01`, plan `KIRO PRO+`.      |
| Does `KIRO_HOME=<tmp>` move the V3 task root?        | No. See the isolation test below.                                       |
| Does authentication survive a relocated `KIRO_HOME`? | Yes. Sign-in lives outside `KIRO_HOME` on macOS.                        |
| Which flag selects V3 for ACP?                       | `acp --agent-engine v3`. Top-level `--v3` launches chat, not ACP.       |
| Is native collection enabled by default?             | Yes, only after the idle preflight; `QUOTA_AXI_KIRO_NATIVE=0` opts out. |

### Current 2.24.1 task-root isolation test, 2026-09-26

The installed 2.24.1 artifacts were `kiro-cli` (74,442,736 bytes, SHA-256
`46b3d4f31e34068b6aa0a4209972656f343e3959615968a52186602dabbd3ac1`) and
`kiro-cli-chat` (423,583,536 bytes, SHA-256
`8b9e052cebb595330906caac0a045da58e3af7ad485566cb18e7c4d7b7768d2e`).
`kiro-cli acp --help` lists `--agent-engine <v2|v1|v3>` (default `v2`) and
`--auth-method cli`. `kiro-cli --help-all` lists no home or task-root option.

Preflight before the live probe:

1. `~/.kiro/tasks` was absent, so no task was running or queued.
2. No `kiro-cli` or `kiro-cli-chat` process of the user was running. The
   desktop companion `kiro_cli_desktop` was running; it does not run tasks.

The probe created a temporary directory, set `KIRO_HOME=<tmp>/.kiro`, and
seeded `<tmp>/.kiro/tasks/canary/coexistence.meta.json` with three synthetic
tasks whose `executionStatus` values were `running`, `queued`, and `succeed`.
This is the file shape that Kiro's startup routine
`clearAllStaleExecutionStatuses` rewrites. It then ran
`kiro-cli acp --agent-engine v3 --auth-method cli` with the real user
environment otherwise, from an empty working directory, and sent only
`initialize` and `_kiro/account/getUsage`.

| Observation                           | Result                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| Usage response                        | Success at 2,974 ms; one `CREDIT` meter, 61.22 used of 2,000 |
| Process lifetime                      | Exit 0 at 3,431 ms; streams closed at 3,432 ms               |
| Stderr                                | 520 bytes; no sign-in, panic, or timeout marker              |
| Canary under `KIRO_HOME/tasks`        | Unchanged: `running` and `queued` statuses still present     |
| `KIRO_HOME` contents                  | Gained `settings/cli.json` only                              |
| Real `~/.kiro/tasks` before and after | Absent before and after; identical snapshot                  |
| Real `~/.kiro` files written          | A new engine log directory under `~/.kiro/logs/`             |
| Engine log line                       | `[KiroAgent] Cleared stale task execution statuses`          |

Conclusion: the V3 engine ran its stale-status cleanup, but against the real
home (`os.homedir()/.kiro/tasks`), not against `KIRO_HOME`. `KIRO_HOME`
relocates settings and sessions only, as the
[official CLI reference](https://kiro.dev/docs/reference/cli-commands/)
documents. Task-root isolation through `KIRO_HOME` therefore does not work on
2.24.1. The binary lists an undocumented `KIRO_DATA_DIR`; overriding `HOME`
while pointing that variable at the real sign-in store was not attempted,
because it would direct the vendor at its credential store through an
undocumented contract.

### Chosen safety design

Because isolation failed, the provider uses an idle guard. It is fail-closed:
uncertainty means no read.

| Step | Check                                                                                      | On failure                        |
| ---- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| 1    | `QUOTA_AXI_KIRO_NATIVE` is not `0`, `false`, `off`, or `no`                                | `kiro_native_disabled`, no launch |
| 2    | `QUOTA_AXI_KIRO_ENGINE` (default `v3`) is `v1`, `v2`, or `v3`                              | `kiro_engine_invalid`, no launch  |
| 3    | `ps` lists no `kiro-cli`, `kiro-cli-chat`, or `Kiro` (IDE) executable for the current user | `kiro_busy_process_active`        |
| 4    | No `~/.kiro/tasks/*/*.meta.json` task has `executionStatus` `running` or `queued`          | `kiro_busy_task_active`           |
| 5    | The process list and every metadata file were readable, parseable, and within bounds       | `kiro_busy_unverified`            |

Only when all checks pass does quota-axi spawn the ACP process. The launcher
uses direct `spawn` with `shell: false`, a detached process group, an empty
quota-axi-owned working directory, and a quota-axi-owned `KIRO_HOME` under the
quota-axi cache directory. The private `KIRO_HOME` does not protect tasks; it
only keeps the read's settings and session files out of `~/.kiro`.

The reader keeps the accepted lifecycle: EOF after a valid response, and fresh
data only after exit 0 and stream close. It now also terminates on failure:
after a 15-second timeout, a protocol error, or an oversized response, it ends
standard input, waits two seconds, sends `SIGTERM` to the process group, and
sends `SIGKILL` two seconds later if the group is still alive. It retains
ownership until exit and close are both observed. Stderr is captured up to
16 KiB only to recognize `error: You are not logged in, please log in with
kiro-cli login`, which becomes `auth_required` with `kiro_not_logged_in`.

Residual risks:

1. A Kiro task that starts in the roughly one-second window between the
   preflight and the ACP engine's startup cleanup can lose its `running`
   status. A Kiro task normally starts inside an already running
   `kiro-cli-chat` process, which the preflight detects.
2. A process-group signal after a timeout can interrupt a vendor token
   rotation in flight. EOF and a two-second grace come first.
3. Kiro reports the reset as a UTC calendar date, so windows have no
   `resetsAt`. The shared stale-cache bound therefore never serves an older
   Kiro snapshot; a skipped read reports `unavailable`.

### Live acceptance with the built CLI, 2026-09-26

The idle preflight passed (no task root, no Kiro process). Running
`node dist/bin/quota-axi.js --provider kiro --json` with a temporary
`XDG_CACHE_HOME` exited 0 in about two seconds and reported:

| Field                   | Value                      |
| ----------------------- | -------------------------- |
| `plan`                  | `KIRO PRO+`                |
| Credits used / limit    | 61.22 / 2,000              |
| `credits.remaining`     | 1,938.78                   |
| `windows[0].resetText`  | `2026-10-01`               |
| `percentRemaining`      | 97                         |
| `pace`                  | `unknown`, `missing_cycle` |
| `quotaSemantics.status` | `unknown`                  |

The `~/.kiro/tasks` snapshot was identical before and after (absent). The only
new files under `~/.kiro` were one engine log directory under `~/.kiro/logs`.
No Kiro process remained afterwards.

## Earlier assessment (2026-09-20, Kiro CLI 2.22.1)

The sections below record the evidence that led to the idle-guard design.

The installed Kiro CLI 2.22.1 has a native, session-free V3 usage route. The
current 2.22.1 repeat acceptance below records three sequential selected-login
exchanges that returned measured quota, accepted normal EOF, exited 0, closed
their streams, and left no observed owned process. The route sends only
`initialize` and `_kiro/account/getUsage`; it sends no session or model request.

A separately approved fixture check then established that the same
account-only process lifetime removes `running` and `queued` statuses from
recognized metadata in the shared task root. That finding is why the provider
now refuses to launch while any Kiro task or process is active.

## Public evidence

| Primary source                                                                                                          | Evidence                                                                                                                              | Limit                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kiro CLI commands](https://kiro.dev/docs/reference/cli-commands/)                                                      | `--v3` selects the V3 harness.                                                                                                        | No standalone quota command or numeric usage schema was established.                                                                                           |
| [Kiro slash commands](https://kiro.dev/docs/reference/slash-commands/)                                                  | `/usage` shows billing information and prints a full breakdown in non-interactive runs.                                               | The page does not establish a V3 non-model dispatch or account-quota output schema.                                                                            |
| [Kiro headless mode](https://kiro.dev/docs/cli/headless/)                                                               | V3 supports non-interactive instructions and structured run events.                                                                   | Run events are not an account-quota contract.                                                                                                                  |
| [Kiro ACP](https://kiro.dev/docs/cli/acp/)                                                                              | `_kiro.dev/commands/execute` is separate from `session/prompt` and is a credible native usage candidate.                              | The V3 usage response schema and fail-closed startup behavior were not established.                                                                            |
| [KiroCrew usage handler](https://github.com/kirodotdev/KiroCrew/blob/main/src/kiro_crew/dashboard/handlers/sessions.py) | The handler describes its non-interactive `/usage` scrape as a billed chat turn. Its API alternative reads stored bearer credentials. | The scrape does not explicitly select V3. Its billing warning is credible risk evidence, not proof of V3 behavior. Credential extraction is outside this task. |
| [KiroCrew ACP component](https://github.com/kirodotdev/KiroCrew/blob/main/docs/system-specs/modules/acp-client.md)      | Its polling safeguards address browser login from unauthenticated CLI commands.                                                       | `--no-interactive` alone is not evidence that polling cannot initiate sign-in.                                                                                 |

These are mutable documentation and source links. Recheck them before resuming.
The public research phase used no live developer credentials, provider
requests, or Kiro sessions. The separately authorized experiment below used
vendor-owned authentication without extracting credentials.

## Installed V3 evidence

The installed `kiro-cli-chat` implementation is version `2.21.4`, build
`20260911.130100`, with SHA-256
`19d2de8490b97c30defaba36a13d58af556578188838e80f32768bbd98ae45d2`.
`codesign --verify --strict` passed. Signing metadata names AMZN Mobile LLC,
team `94KV3E626L`, dated 2026-09-11.

The [official installer](https://cli.kiro.dev/install) identifies the vendor
download base. The [official 2.21.4 macOS artifact](https://prod.download.cli.kiro.dev/stable/2.21.4/Kiro%20CLI.dmg)
is publicly available. The [current stable manifest](https://prod.download.cli.kiro.dev/stable/latest/manifest.json)
reports `2.22.0`. The installed binary digest is a local observation, not a
verified match against a public package digest.

| Installed binary byte offset | Observed contract                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `423870317`                  | Native V3 `usage` dispatch calls `_kiro/account/getUsage` and unwraps nested `success`, `message`, and `data`.                                                                               |
| `423877541`                  | The UI client requires a session. The separately inspected server usage route does not.                                                                                                      |
| `426493092`                  | The usage renderer reads `planName`, `billingCycleReset`, and `usageBreakdowns` entries with `displayName`, `used`, `limit`, and `hasLimit`. It calculates used percent from `used / limit`. |
| `426492886`                  | Add-on and bonus fields are separate. Their relationship to the effective bound needs transport evidence.                                                                                    |
| `423838430`                  | Default V3 client metadata enables hooks.                                                                                                                                                    |
| `423839100`                  | A control-plane endpoint override accepts HTTP(S) loopback only.                                                                                                                             |
| `426655965`                  | The token callback delegates to vendor `get-kas-token`, which can refresh expired tokens.                                                                                                    |
| `426657500`                  | One secret-storage root uses `os.homedir()` directly. `KIRO_HOME` alone does not isolate every store.                                                                                        |

Bounded native help and version checks used an allowlisted environment, empty
synthetic `HOME` and `KIRO_HOME`, and an empty worktree-local cwd. Direct ACP
help supports `--agent-engine v3` and `--auth-method cli`. Help execution does
not establish ACP startup safety.

An extracted usage dispatcher ran in a Node VM with mocked `callExtMethod`.
Three checks passed: native method selection and data unwrapping, outer
failure preservation, and nested failure preservation. No real CLI startup or
session occurred. This proves dispatcher behavior only. It does not prove
the server schema or authentication behavior. Research artifacts are local
under `.tmp-cache/kiro-research/` and are not product fixtures. They were
moved from `.agent-kit/kiro-research/` after the probes. Recorded argv and
profile hashes above describe their original execution paths. Private local
paths in this assessment use the portable `<worktree>` placeholder.

Independent review requires a verified configuration boundary, denial of live
credential and Keychain access, denial of real network and browser launch,
and no hooks or MCP startup before any actual relay test. Mocking quota-axi's
ACP peer alone cannot establish vendor behavior.

## Actual KAS server contract

### Current 2.22.0 acceptance preflight, 2026-09-17

The selected-login grant permits vendor-owned authentication and normal
vendor-managed refresh. It does not permit worker credential extraction or
waive task-state protection. No live usage exchange had been attempted at
preflight 019.

Current installed evidence supersedes the 2.21.4 version observation above.
The bundle metadata and bounded native `kiro-cli-chat --version` both report
`2.22.0`. Strict code-signature verification passed. The universal binary
SHA-256 is `0dfe351ac7afd99a16210b66429e255d3f13fa0701bce7a9225ee88e71f1b58f`.
Bounded `acp --help` confirms `--agent-engine v3 --auth-method cli`.
Both commands exited 0 using a synthetic home and empty cwd. They performed
no ACP initialization or usage exchange and establish command compatibility
only. Their outputs contain help/version text, not account data.

Read-only inspection of the signed binary's arm64 archive copied only the
public ACP server source and package metadata into local research storage.
The package is `@kiro/agent` `0.66.0`. The 11,499,652-byte server source
SHA-256 is `fa5d60d7ec7450b11d2a4d8aad9c1fa69170268bd80eafad1d16065bfc06f9fb`.
The extracted source was not executed and remains outside product code.

| Current source byte offset | Source evidence                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `11269529`                 | The constructor selects `homeDir` from its option or `os.homedir()`.                                                          |
| `11284534`                 | Platform initialization calls `clearAllStaleExecutionStatuses(this.homeDir)`.                                                 |
| `8314974`                  | That routine scans `<home>/.kiro/tasks`; it clears `running` and `queued` statuses without checking task-owner liveness.      |
| `8312337`                  | Its named file-lock helper is an in-process Promise queue; it does not protect another Kiro process.                          |
| `11495442`                 | The extracted server accepts `home-dir`; this does not establish forwarding through the installed supported CLI route.        |
| `11442748`                 | The usage handler still calls vendor-owned usage transport without a session or model prompt.                                 |
| `11279295`                 | Connection closure starts session disposal. This is partial teardown evidence, not proof of complete relay or refresh safety. |

The exact blocker for preflight 019 was unestablished protection of active task metadata during
selected-account ACP startup. Installed ACP help exposes no home-isolation
option. The [official CLI environment reference](https://kiro.dev/docs/reference/cli-commands/)
documents `KIRO_HOME` for agents, prompts, skills, steering, settings and
sessions. It does not establish task-store relocation or forwarding to the
KAS `homeDir` option. This is an evidence gap, not proof that isolation is
impossible or that the native relay has already changed task metadata.
An empty cwd alone cannot establish task-home protection.
Independent read-only review confirmed the cleanup, missing liveness check
and in-process queue in the current source. The reviewer did not inspect
real task metadata or credentials.

Current source also supplies partial EOF teardown evidence: connection
closure leads to `disposeAllSessions()`, which waits for initialization and
controller cleanup. No supported installed one-shot completion guarantee or
safe vendor-refresh completion was established. The live exchange remains
unconsumed. There was no model/session request, login, browser action,
account switch, separate token-helper invocation, permission change or
installation. Existing collector gates and publication hold remain in force.

### Maintenance-window completion check, 2026-09-17

Firstmate instruction 020 records the user's confirmation of no active Kiro
tasks and authorization for the single selected-login attempt. Disclosed
vendor task-status cleanup is accepted for that attempt. Separate task-home
isolation is therefore no longer its blocker. This does not establish safe
concurrent production polling.

The current bundle still reports 2.22.0; strict signature verification passes,
and the complete binary digest matches the preflight 019 artifact. The
supported route remains `acp --agent-engine v3 --auth-method cli`.
No authenticated ACP child was launched and no exchange was consumed.

The remaining concrete boundary is safe completion of an outstanding
CLI-owned authentication refresh when the external ACP input closes.
The current callback provider can return a cached token while starting
`runBackgroundRefresh()` without awaiting it. Its `refreshPromise` is not
drained by the KAS connection-close/session-disposal path. A usage response
therefore does not prove that vendor token-store rotation has settled.

Read-only inspection of the installed native relay found stronger partial
completion evidence than the public ACP reference provides:

| Installed arm64 binary byte offset | Public relay diagnostic                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `743757854`                        | External ACP stdin closed; draining accepted V3 engine responses. |
| `743757028`                        | Timed out draining CLI authentication tasks after relay shutdown. |
| `743755610`                        | Timed out reaping the V3 engine process after SIGKILL.            |
| `743755547`                        | Failed to terminate the complete process tree for the V3 engine.  |

These diagnostics establish drain and termination machinery in the artifact.
They do not establish control-flow ordering, timeout cancellation behavior,
or token-store persistence before retirement. No runtime path was exercised.
The worker has not proved that EOF waits safely for outstanding CLI-owned
rotation, or that bounded completion avoids interrupting authentication.
Independent read-only review confirmed the callback/disposal source and
native diagnostic window. The relay may supply the missing safe drain;
the evidence does not prove EOF intrinsically unsafe.
Keeping stdin open would leave completion unestablished; signaling the
process is prohibited. No keeper process or other framework was introduced.

At completion check 020, the live attempt remained unused at this lifecycle
boundary. No credential values, account data, raw protocol or real task contents were read
or retained. The worker ran no model/chat/session request, login/browser
action, account switch, separate refresh helper, installation, retry or
generic Node probe. Native wiring, publication, merge and installation remain
held.

### Single selected-login experiment, 2026-09-17

Instruction 021 accepts normal vendor EOF shutdown for exactly one
maintenance-window attempt. The user accepted the previously disclosed
refresh-persistence uncertainty for this experiment. That acceptance does
not establish production safety. The worker verified the frontend signature
and digest and checked ACP help with a synthetic home before the attempt.
The frontend SHA-256 was
`0a517b0499ebc7251d6f593e98f6588259f7585c4606731cd5235e28446163d3`.

The attempt started at `2026-09-17T20:01:08.955Z` using installed Kiro 2.22.0
and `acp --agent-engine v3 --auth-method cli`. The existing protocol reader
sent only `initialize`, then `_kiro/account/getUsage`. The vendor inherited
its selected environment directly through Node spawn. The worker did not
inspect or copy credential values. An exclusive attempt marker prevented
repetition. No model, chat or session request was sent.

The existing adapter received a fresh credit window after 2.05 seconds.
The normalizer used reported used credits and allowance, then applied the
shared percent-remaining calculation. It preserved the reported reset as
calendar-date text. Cycle duration and pool relationships remained unknown;
there was no effective bound, pace forecast, runway or selection scalar.
Normalized quota and numeric credit amounts remain in worktree-local
experiment evidence; no raw protocol, stderr or account identity was retained.

The worker sent normal EOF after the response. It sent no signals, destroyed
no pipes and performed no retry. The owned process, PID 57112, exited with
code 1 and no exit signal. Its streams closed after 7.57 seconds. The worker
retained supervision until that observed close. No forced worker shutdown
occurred. Vendor-internal descendant cleanup and token-store persistence
were not independently observed.

Quota transport succeeded in this attempt. Process completion was observed,
but exit code 1 is not a clean-shutdown receipt. Its cause is unknown because
stderr and raw protocol were deliberately discarded. The experiment does
not establish auth-failure behavior, near-expiry refresh completion, timeout
cleanup, concurrent task safety or safe repeated polling. The sole authorized
exchange is consumed. Any further native experiment needs separate authority.
Independent native `/usage` comparison was not performed. Default wiring,
publication, merge and installation remain held.

Independent review confirmed the two-request guard, serialized evidence
writes and retained process ownership before launch. Independent post-attempt
review confirmed the normalized arithmetic and observed close. The reviewer
classified the quota response as successful and the vendor exit as nonzero,
with production acceptance still outstanding.

### Current 2.22.1 repeat acceptance, 2026-09-20

The current installed frontend is Kiro CLI 2.22.1. The signed `kiro-cli`
artifact is 102,933,232 bytes with SHA-256
`c770b9ed9e45c390ccaf6b1072ca4cbe23241161b6ce7ba61b27e328e57c849f`.
The signed `kiro-cli-chat` artifact is 798,050,864 bytes with SHA-256
`de55e5d1d9d0e774ff1390c767dd7d923e5729494f032a1996a512a75b2bbf1e`.
Public UI metadata identifies `@kiro/agent` 0.66.4.

Three sequential account-only ACP exchanges used the same fixed route and
request pair as the failed 2.22.0 experiment. Each preflight found no active or
queued Kiro task metadata. Each run sent normal EOF after the valid response,
sent no signal, and retained ownership through natural process completion.

| Run          | Response | Exit / stream close | Final empty process observation |
| ------------ | -------: | ------------------: | ------------------------------: |
| 038          | 1,201 ms |            1,660 ms |                        1,674 ms |
| 039 repeat 1 | 1,074 ms |            1,514 ms |                        2,043 ms |
| 039 repeat 2 |   957 ms |            1,417 ms |                        1,438 ms |

All three runs returned the same normalized numeric meter, exited 0, closed
their streams, and matched no configured engine-exit or authentication-drain
timeout marker. Preflight and postflight both found the task directory absent.
The historical 2.22.0 exit-1 evidence remains valid for that version.

Historical (2.22.1): at this point the product reader mirrored the accepted
success lifecycle. It sent normal EOF after a valid usage response, continued
draining, and resolved only after exit 0 and stream close. Nonzero exit and
lifecycle timeout became unavailable or eligible stale evidence. The reader
never signalled the process, and default launch remained unbound. The shipped
reader now terminates the process group after a failure or timeout, and launch
is enabled by default behind the idle guard; see the README.

The remaining native boundary is task coexistence. The supported ACP command
exposes no task-home selector. `KIRO_HOME` forwarding to the KAS `homeDir` is
not established, and current KAS 0.66.4 source is unavailable. A synthetic
home loses the selected vendor login. Copying or reading credentials to combine
those environments is prohibited. Maintenance-empty runs therefore do not
prove safe polling while another Kiro task is active.

A separately approved real-home disposable fixture resolved this evidence gap.
The current runtime recognized the fixture and modified it. The result is a
task-coexistence failure, not permission to enable the native launch.

### Current 2.22.1 task-coexistence check, 2026-09-20

The bounded canary started with no task root, no active or queued task metadata,
and no blocking Kiro CLI process. Strict signature checks passed for the same
2.22.1 artifacts and digests listed above. The canary then created one
exclusive `0700` subtree under `~/.kiro/tasks` and one `0600`
`coexistence.meta.json` file. The file contained three synthetic entries:

| Entry       | Status before | Status after | Other observed change |
| ----------- | ------------- | ------------ | --------------------- |
| `running`   | `running`     | absent       | `updatedAt` advanced  |
| `queued`    | `queued`      | absent       | `updatedAt` advanced  |
| `completed` | `succeed`     | `succeed`    | None                  |

The file changed from 786 bytes with SHA-256
`539691ab4e8cd482e8a37461410c6422a59864750cd67d882b0c5e7e6635fe22`
to 714 bytes with SHA-256
`bbc08540a028ac50b2de81c626d576c230eff6b192da3295b2e988902223b769`.
The runtime replaced the file inode, changed its mode from `0600` to `0644`,
removed only the two active statuses, advanced only their timestamps, and
preserved the completed entry. This selective rewrite is positive
current-runtime recognition of the fixture format. An unchanged unknown JSON
file would not have supplied that evidence.

The canary sent only `initialize` and `_kiro/account/getUsage`. It received a
measured credit window at 3,047 ms. The direct child exited 0 and all streams
closed at 3,526 ms. No owned process remained at the 3,546 ms observation.
All 520 stderr bytes were classified, with no configured engine-exit,
authentication-drain, cleanup, or uncaught-exception marker. No session or
model request, credential read, signal, retry, installation, or real task edit
occurred.

The result records `cleanup.attempted` and `cleanup.completed`, with no unowned
entry observed before cleanup. Postflight found the task root absent with the
original empty aggregate digest and found no blocking Kiro CLI process.

This check proves that the supported account-only ACP process lifetime in Kiro
CLI 2.22.1 can clear `running` and `queued` statuses in recognized task
metadata. It does not isolate the mutation to initialization, usage handling,
or shutdown. It also does not claim broader task-content corruption or
characterize every possible concurrent process schedule. The observed action
is enough to reject unattended shared-home polling. A preflight that sees no
active task still has a time-of-check/time-of-use race with a task that starts
before Kiro initialization. Native default binding therefore remains disabled
until the supported launcher provides an isolated task home or vendor-enforced
cross-process protection that preserves live task state.

### Supported alternatives and vendor requirement

The gathered evidence contains no supported automatic individual-account
alternative that is both non-model and non-mutating. The installed 2.22.1
headless `chat --v3 --no-interactive /usage` candidate returned a
natural-language refusal and no quota. It does not replace the native account
RPC.

Kiro's documented enterprise CSV and OpenTelemetry exports provide dated
historical consumption for administrator-managed organizations. They do not
provide a fresh individual remaining-credit reading, bonus or add-on balance,
or exact reset. The documented subscription portal provides a manual usage
view. A future manual snapshot import would have to remain explicitly dated
manual evidence; quota-axi must not present it as fresh unattended collection.
No export or manual-import feature is implemented in this slice.

The smallest actionable vendor requirement is one of these supported
contracts:

1. An account-only usage mode that does not initialize or rewrite the task
   subsystem.
2. A launcher option that moves the task root to an isolated directory while
   preserving the vendor-selected account and authentication stores.
3. Vendor-enforced cross-process task ownership that never clears a live
   task's status.

Until one contract exists and passes native acceptance, the permitted product
slice is parser, cache-fallback, and dashboard support behind an unbound native
reader. Installation cannot enable live Kiro collection from this branch.

Vendor token-refresh persistence after a clean vendor exit is residual vendor
uncertainty. quota-axi's required behavior is narrower: it does not read or
exchange refresh tokens, does not force expiry, waits for the vendor process to
exit cleanly before publishing fresh evidence, and reports failures as
unavailable or stale. Internal token-store inspection is not an acceptance
requirement.

If task coexistence is resolved, the smallest default-launch change is a
production factory for the existing reader. The factory must use direct
shell-free spawn, inherit the selected vendor environment without inspecting
credentials, select a dedicated empty working directory, and inject the reader
into `kiroAdapter`. Existing overlap ownership rejects a second poll while the
first child remains pending.

### Earlier 2.21.4 research

The native binary embeds a gzip archive at bytes `88048910` through
`229857444` (exclusive). Its compressed SHA-256 is
`f4641ef4651b282068df99d5a37902969b37e9d35c397f2d4b84ac90f7ed340f`.
Read-only streaming inspection verified the hash. The parent copied only two
exact regular-file members into local research storage, without running Kiro:
`node_modules/@kiro/agent/dist/server/acp-server.js` and the package metadata.
The package version is `0.63.3`. The extracted vendor source is research
evidence, not code to vendor into quota-axi.

Two independent source readers confirmed this request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "_kiro/account/getUsage", "params": {} }
```

The server classifies usage as `localOnly`. The handler ignores parameters
and performs no session lookup. It calls the vendor's injectable usage
transport and normalizer. It does not enter `session/new`, `session/prompt`,
hooks, MCP, or model handlers. The default usage transport calls
`GetUsageLimits` through vendor-owned authentication.

The parent executed the extracted usage handler and normalizers in a Node VM
with mocked usage transport and authentication metadata. Three additional
checks passed: used/allowance normalization, transport failure reporting, and
empty-response reporting. All six research checks used immediate mocks;
no native startup, session, credential, or account request occurred.

The normalizer truncates the vendor's reset timestamp to a UTC calendar date.
Keep that date as reset text. Do not invent midnight or reconstruct exact
bonus/add-on expiry from rounded days or calendar dates. Plan, bonus, and
add-on relationships need explicit evidence before an effective bound.
The admin-managed unsupported branch returns success without measured data;
report unmeasured quota rather than zero usage.

## Harmless guard diagnosis under instruction 002

The profile `.agent-kit/kiro-research/noauth-guard.sb` has SHA-256
`9a6586513a806e59a36c7e70e5324ec870331d6a778ccad5f34cbb6538fa3351`.
Its default is deny. It permits execution of only
`/opt/homebrew/Cellar/node/26.3.0/bin/node`, selected runtime reads, and writes
beneath the synthetic guard home. No profile allowance was changed for these
comparisons.

Every comparison used cwd
`<worktree>/.agent-kit/kiro-research`
and this exact environment:

```json
{
  "HOME": "<worktree>/.agent-kit/kiro-research/guard-home",
  "KIRO_HOME": "<worktree>/.agent-kit/kiro-research/guard-home/.kiro",
  "NO_COLOR": "1",
  "PATH": "/usr/bin:/bin",
  "TERM": "dumb"
}
```

The exact guarded argv prefixes each baseline argv with
`/usr/bin/sandbox-exec -f <worktree>/.agent-kit/kiro-research/noauth-guard.sb`.
Every subprocess had a six-second timeout. None timed out.

| Baseline argv                                         | Unguarded result                       | Guarded result                                                                                            |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/opt/homebrew/Cellar/node/26.3.0/bin/node --version` | Exit 0; stdout `v26.3.0`; empty stderr | Signal 6 (`SIGABRT`, subprocess return -6); empty stdout and stderr                                       |
| `/usr/bin/true`                                       | Exit 0; empty stdout and stderr        | Exit 71; empty stdout; stderr `sandbox-exec: execvp() of '/usr/bin/true' failed: Operation not permitted` |

The process-denial test proves that the sandbox initializes and applies an
execution restriction. It does not support a general nested-sandbox failure.
Node starts unguarded and aborts guarded. The exact denied Node prerequisite
is unknown. Earlier empty guard-check captures do not prove credential,
Keychain, network, browser, or descendant-process isolation. Those denial
tests remain unverified because the runtime did not reach them.

No safe guard correction is established. Do not repeat the identical failed
self-test or weaken the guards. A supervised runtime diagnostic or an
accepted alternative isolation mechanism is an external prerequisite for a
native startup test. No KAS server or live account operation was started.

## Implemented mocked slice

> Historical (2026-09-20). Superseded by [Current result](#current-result):
> native collection is now wired and enabled behind the idle preflight.

`src/providers/kiro.ts` adds PATH discovery and parsing to the existing provider
registry. Its default transport remains absent. The parser accepts the native
ACP result envelope and keeps plan, bonus, and add-on credits separate.
`src/interpretation.ts` applies the existing unknown-relationships semantics;
`src/tui.ts` adds only the provider accent. The existing cache, CLI, JSON, and
TOON owners handle the normalized provider without a second control plane.

The parser derives used percent from finite, nonnegative used credits and
allowance, then applies the shared remaining-percent helper. Unknown resources,
unlimited meters, and zero allowances have no inferred percentage. A malformed
response remains unavailable. Admin-managed success without data remains
unmeasured, so it cannot erase cached quota as a fresh empty reading. Only an
explicit valid empty usage array is a fresh empty result in mocked tests.

Date-only reset text is preserved without a timestamp. Rounded bonus expiry
and add-on expiry do not supply cycle times. Add-on `isActive: false` is not
proof that credits are unusable, so those packs remain visible. There is no
combined bound, pace forecast, runway, or selection scalar for unresolved
pool relationships. No manual balance entry or credential reader was added.

## Historical 2.22.0 acceptance snapshot

> Historical (2026-09-20). Superseded by [Current result](#current-result):
> native collection is now wired and enabled behind the idle preflight.

The table below records the gate state after the 2.22.0 exit-1 experiment. The
current 2.22.1 repeat evidence and reader lifecycle section above supersede its
lifetime and repeatability conclusions. The task-coexistence boundary remains.

| Gate                         | Current evidence and remaining requirement                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: mocked implementation     | Fixed protocol, option guards, bounds and retained child ownership have deterministic coverage. Native behavior is not established by these tests.                                                                                                            |
| B: supported installed route | Installed 2.22.0 signatures, help and one actual V3 response establish the selected route for this artifact. Extracted KAS source remains research only. Recheck provenance for any changed installation.                                                     |
| C: safe synthetic startup    | The one maintenance-window attempt accepted disclosed task cleanup. Concurrent production safety and unauthenticated no-login behavior remain unverified. The failed sandbox self-test provides no accepted isolation evidence.                               |
| D: native lifetime           | One response and EOF close were observed, with exit code 1. Establish its cause and safe auth failure, near-expiry refresh, timeout and parent exit. Token-store completion and descendant cleanup remain unverified. No second native attempt is authorized. |
| E: selected-account usage    | The single authorized exchange returned measured quota. Compare independently supplied native `/usage` values, arithmetic, unknown resets, failures and TUI output. No comparison was performed in this attempt.                                              |

At that point, A-D had to pass before native default wiring. Current 2.22.1
evidence passes the happy-path lifetime and sequential-repeat checks. Task
coexistence still blocks default launch. Routine vendor initialization is not
automatically prohibited; assess each effect against the least-action policy in
VISION.md. The synthetic diagnostic guard is not a new production contract.
Existing Codex app-server behavior differs from rejection-gated delegates and
is unchanged here. Native worker-adapter verification and the separate scout
are independent.

## Delivery and installation scope

> Historical (2026-09-20). Superseded by [Current result](#current-result):
> native collection is now wired and enabled behind the idle preflight.

Draft publication branch: `fm/quota-axi-kiro-draft`, based on `9f63b42`.
The original `fm/quota-axi-kiro` branch and its research commits remain local.
The draft branch copies the implementation without that private-path history.
Its branch-only `.no-mistakes.yaml` requests GitHub draft creation and changes
no trusted command or validation policy. The handoff records its exact commit.
Push, pull request, and no-mistakes validation remain pending. No pipeline run
was started. The six mocked handler checks are research checks, not collector
acceptance. Native default collection remains disabled. Current happy-path
shutdown no longer needs another unchanged live read.

### Product verification

Focused regression command:

```sh
pnpm exec vitest run test/providers/kiro-cli.test.ts test/providers/kiro.test.ts test/cli.test.ts test/tui.test.ts test/cache.test.ts
```

Current focused verification passed 66 Kiro provider, lifecycle, and cache
tests. Independent review confirmed that the reader now sends normal EOF only
after a valid correlated response, waits for both exit 0 and stream close, and
keeps timed-out children pending until observed completion. The failed-spawn
case remains narrowly released only after positive no-process evidence. Late
events from an old child cannot release a replacement. These deterministic
tests launched no native child.

The [Node child-process contract](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html#subprocesspid)
defines missing PID on failed spawn and the spawn/error/close event behavior.
The [Node 22.23.1 implementation](https://github.com/nodejs/node/blob/v22.23.1/lib/internal/child_process.js)
identifies asynchronous spawn errors with `syscall: "spawn <executable>"`.
Those existing process contracts support the narrow exception; a generic
child error does not establish failed creation. Default native launch remains
blocked on task coexistence.

Complete gate used the already-installed Node `22.23.1`, with
`/opt/homebrew/opt/node@22/bin` prepended to PATH. No runtime was installed.

| Command                           | Result                               |
| --------------------------------- | ------------------------------------ |
| `pnpm run build`                  | Passed; also repeated by `pnpm test` |
| `pnpm test`                       | 1142 tests passed across 51 files    |
| `pnpm run lint`                   | Passed                               |
| `pnpm run format:check`           | Passed                               |
| `pnpm run build:skill -- --check` | Passed; generated skill unchanged    |
| `git diff --check`                | Passed                               |

Sanitized draft preparation repeated the 168 focused tests under Node
`22.23.1`, with worktree-local synthetic home, temporary and cache directories.
The worker invoked the already-installed runner directly:

```sh
node node_modules/vitest/vitest.mjs run test/providers/kiro-cli.test.ts test/providers/kiro.test.ts test/cli.test.ts test/tui.test.ts test/cache.test.ts
```

At the sanitized draft commit, build, lint, full formatting and generated-skill
checks passed, and product/test Git blobs matched the preserved original branch.
The current lifecycle and stale-cache changes supersede that unchanged-code
statement. Independent review of the current slice found no privacy blocker;
default binding remains withheld.

An initial `pnpm exec` invocation under the empty synthetic home unexpectedly
attempted pnpm self-installation for the declared version `11.1.1`. The worker
interrupted that invocation, which exited 130 before Vitest ran. Installation
completion was not established. The direct runner then passed the focused
regressions. No manifest or lockfile changed. Synthetic-home artifacts remain
local and are not part of the publication branch.

The first full-suite attempt under Node `26.3.0` had four failures in unchanged
HTTP proxy tests: `invalid onError method` and expected proxy connections not
observed. All seven HTTP tests then passed under Node `22.23.1`; the complete
suite also passed there. The HTTP implementation, its tests, and dependency
manifests are unchanged. This is a runtime-specific residual limitation, not
native Kiro acceptance. Hosted CI uses Node 24 and has not run for this slice.

After the task-coexistence decision and default-launch implementation, validate
and publish through the existing no-mistakes pipeline to
`davidtandoh/quota-axi`. Preserve both the historical 2.22.0 exit-1 evidence
and the current 2.22.1 clean repeats. A passing pipeline does not authorize a
merge. Merge needs the recorded grant and complete acceptance.

Installation remains a later, separately authorized action. Build an artifact
from the reviewed commit, test it against synthetic usage output, and then
complete the remaining V3 acceptance before replacing an installed CLI.
The third additional read authorized in instruction 039 remains unused. Do not
spend it on the unchanged happy path. Confirm provider selection, credit
arithmetic, unknown reset behavior, failure handling, and the existing TUI
card. Do not install or release packages from this task.

During the assessment formatting check, `pnpm exec` automatically materialized
the worktree's local development dependencies. No global CLI installation or
package release occurred. No dependency manifest or lockfile changed.

## Repository setup note

`fm-ensure-agents-md.sh .` refused because `AGENTS.md` and `CLAUDE.md` are both
regular files. `CLAUDE.md` already imports `AGENTS.md`. Neither file was changed;
do not replace them as part of a transport repair.
