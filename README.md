# herdr-codex-autoresume

A Herdr plugin that automatically resumes [Codex CLI](https://github.com/openai/codex) `/goal`
after the OpenAI usage limit resets. When Codex hits a usage limit, the plugin records the reset
time, waits for it, then types `/goal resume` + Enter into the live Codex TUI so the user's goal
keeps running unattended.

## What it does

```text
Codex CLI TUI (user's preferred model)
    ↓
/goal executes
    ↓
Codex reaches usage limit
    ↓
Codex auto-switches the open TUI to a reserved "Luna Reserve" model —
the goal pauses, but the session in this pane is no longer on the
user's model.
    ↓
Plugin sees `pane.agent_status_changed` for the Codex pane
    ↓
Plugin reads the recent terminal text
    ↓
Plugin matches "usage limit" / "rate limit" / "limit resets" /
"try again at …"
    ↓
Plugin captures the original model name (e.g. "gpt-5.6-sol") from the
status line and the Codex session id from `pane.agent_session.value`
    ↓
Plugin parses the reset timestamp (absolute or relative, with timezone)
    ↓
Plugin writes the pending entry to
`HERDR_PLUGIN_STATE_DIR/state.json`
    ↓
Long-running scheduler process sleeps until reset time
    ↓
On wake the scheduler re-validates the pane (still codex? same session
id? still limited?)
    ↓
Scheduler splits a fresh pane (default: right)
    ↓
Scheduler launches `codex -m <original-model> resume <session-id>`
in the new pane via `herdr pane run` (atomic submission with Enter)
    ↓
Scheduler waits for the "Resume paused goal?" dialog in the new pane
    ↓
Scheduler sends `1` then `Enter` to confirm "Resume goal"
    ↓
Scheduler waits briefly for the new pane's agent to return to
`working` and confirms the resume succeeded
    ↓
The original (Luna) pane is left untouched so the user can compare or
fall back manually
```

The plugin never edits the open Codex TUI to skip its dialogs. The
"Resume paused goal?" dialog is the Codex-native prompt for resuming a
paused session; the plugin selects option 1 ("Resume goal") and submits
Enter. The plugin never auto-approves permission prompts, never runs
shell commands on the user's behalf, and never modifies Codex's own
configuration.

## Requirements

- Herdr **0.9.0** or newer.
- Node.js **20+** (only used at runtime — Herdr invokes the plugin through `node`).
- Codex CLI installed and reachable via `codex resume <session-id>` for native session restore.

## Install

### Local development (recommended while authoring)

```bash
git clone <your-fork> herdr-codex-autoresume
cd herdr-codex-autoresume
npm install
npm run build
herdr plugin link "$(pwd)"
```

`plugin link` registers the plugin in your user-global plugin list and creates
`~/.config/herdr/plugins/config/codex.autoresume/` (config) and
`~/.local/state/herdr/plugins/codex.autoresume/` (state) on first use.

After linking, restart Herdr once so the `[[startup]]` hook fires and spawns the scheduler process.

### GitHub install

```bash
herdr plugin install <owner>/herdr-codex-autoresume
```

`plugin install` clones the repository into Herdr's managed plugin directory, runs the
`[[build]]` command (`npm install && npm run build`), and registers the plugin. Reinstall
to update; use `--ref <sha-or-tag>` to pin a revision.

## Architecture

Plugin v1 in Herdr does **not** provide a long-lived background service. Startup hooks are
one-shot, and every event hook invocation runs in a fresh process. To deliver scheduling across
restarts without tmux/screen/GUI automation, this plugin uses a **detached child scheduler
process**:

- `[[startup]]` (`dist/cli/startup.js`) runs once after Herdr restores a session. It spawns
  `dist/cli/scheduler.js` as a detached Node process via `spawn({ detached: true })`, records
  the pid in `HERDR_PLUGIN_STATE_DIR/scheduler.pid`, and exits. Herdr sees the startup command
  finish immediately and remains responsive.
- `[[events]]` (`pane.agent_detected`, `pane.agent_status_changed`) handlers run in fresh
  short-lived processes. They read state, detect limits, and write tiny JSON "intent" files to
  `HERDR_PLUGIN_STATE_DIR/intents/`. They never write the main state file directly; only the
  scheduler does, with atomic temp-file rename.
- The detached `scheduler.js` process acquires a pid-file lock, drains intent files in
  lexicographic order, processes due entries, sleeps until the next wake-up, and exits cleanly
  when no entries remain or on `SIGTERM`/`SIGINT`/`SIGHUP`. Wake latency is bounded by
  `pollIntervalSeconds` (default 10s).
- Persistent state lives in `HERDR_PLUGIN_STATE_DIR/state.json` and is written atomically
  (write temp → fsync → rename). A corrupted state file is quarantined as
  `state.json.corrupt.<ts>` and a fresh state is started.

The single scheduler process owning state writes makes the design race-free without a
cross-process lock library: even if multiple event handlers fire concurrently, they only
enqueue intents, and the scheduler drains them sequentially. The scheduler additionally
deduplicates resume attempts within a single tick by transitioning each entry to `resuming`
before sending the slash command and refusing to send twice.

### Source layout

```
herdr-codex-autoresume/
├── herdr-plugin.toml       # manifest: id, startup, events, actions
├── package.json
├── tsconfig.json           # typecheck only (includes tests)
├── tsconfig.build.json     # emit only (rootDir: src/)
├── scripts/build.mjs       # npm run build → dist/
├── fixtures/               # offline Codex TUI text for simulator mode
├── src/
│   ├── types.ts            # domain types (entry, intent, config)
│   ├── config.ts           # config load + validation
│   ├── log.ts              # structured JSON logger (stdout + file)
│   ├── herdr.ts            # HerdrClient interface + CliHerdrClient
│   ├── detector.ts         # usage-limit detection + reset parsing
│   ├── state.ts            # StateStore: atomic JSON, intents
│   ├── backoff.ts          # bounded exponential backoff
│   ├── resume.ts           # preflight + performResume
│   ├── scheduler.ts        # runScheduler loop + pid/lock helpers
│   ├── event.ts            # event handlers (write intents)
│   ├── actions/
│   │   ├── status.ts
│   │   ├── resume-now.ts
│   │   └── cancel.ts
│   └── cli/                # one-file entry shims for the manifest
│       ├── startup.ts
│       ├── scheduler.ts
│       ├── event.ts
│       ├── status.ts
│       ├── resume-now.ts
│       ├── cancel.ts
│       └── paths.ts
└── test/
    ├── detector.test.ts
    ├── state.test.ts
    ├── backoff.test.ts
    ├── scheduler.test.ts
    ├── resume.test.ts
    ├── actions.test.ts
    └── fake-herdr.ts
```

## Configuration

The plugin reads `<HERDR_PLUGIN_CONFIG_DIR>/config.json`. Herdr seeds this file on first
link. Defaults:

```json
{
  "enabled": true,
  "resumeCommand": "/goal resume",
  "splitDirection": "right",
  "maxReadLines": 120,
  "retryMaxSeconds": 300,
  "resumePaneLaunchTimeoutSeconds": 30,
  "resumeDialogTimeoutSeconds": 30,
  "resumeVerificationSeconds": 15,
  "pollIntervalSeconds": 10,
  "dryRun": false
}
```

Field reference:

- `enabled`: master switch. When false, event handlers and scheduler no-op safely.
- `resumeCommand`: kept for parity with the simple `/goal resume` flow. The plugin only uses it
  in dry-run logs; the actual recovery launches `codex -m <model> resume <session-id>`.
- `defaultCodexModel`: optional fallback model used when the original pane text has no quality
  keyword (`high` / `medium` / `low`) to parse from. Most users do not need to set this; the
  plugin reads the live Codex status line.
- `splitDirection`: `"right"` or `"down"` — direction of the new pane the plugin spawns to
  run `codex resume`. Defaults to `"right"`.
- `maxReadLines`: how many of the most recent rendered rows of the Codex pane to read when
  scanning for limit messages. Caps I/O cost.
- `retryMaxSeconds`: cap of the exponential backoff ladder `[5, 15, 30, 60, 120]` seconds.
  After the ladder, the schedule stays at this value.
- `resumePaneLaunchTimeoutSeconds`: how long to wait for the new `codex resume` pane to
  produce a recognizable dialog before declaring the spawn failed.
- `resumeDialogTimeoutSeconds`: how long to wait for the "Resume paused goal?" dialog after
  launching the new pane.
- `resumeVerificationSeconds`: how long to wait for the resumed Codex pane to enter
  `working` after answering the dialog.
- `pollIntervalSeconds`: scheduler tick. Bounds wake latency after reset and after an event.
- `dryRun`: when true, the scheduler records the intended `codex resume` launch but never
  splits a pane or sends keys. Useful for proving the detection path without disturbing
  Codex.

## Actions

Three actions are registered (invocation context provides `focused_pane_id`):

- **Codex Auto Resume: Status** — prints pending entries and their state. With `--json` it
  emits the structured report.
- **Codex Auto Resume: Resume now** — runs the same validation + send flow as the scheduler,
  immediately. Records the outcome to state. Honors `dryRun`.
- **Codex Auto Resume: Cancel** — drops the pending auto-resume for the focused pane.
  Does **not** close Codex itself.

Invocation:

```bash
herdr plugin action invoke codex.autoresume.status
herdr plugin action invoke codex.autoresume.resume-now
herdr plugin action invoke codex.autoresume.cancel
```

When the focused pane does not match a pending entry, the actions reply with an
`invoked: false, reason: …` JSON message.

## State

`HERDR_PLUGIN_STATE_DIR/state.json`:

```json
{
  "version": 1,
  "nextWakeAtMs": 0,
  "entries": {
    "w1:p3": {
      "paneId": "w1:p3",
      "agentKind": "codex",
      "sessionId": "0190aaaa-bbbb-cccc-dddd-000000000001",
      "originalModel": "gpt-5.6-sol",
      "detectedAtMs": 1790281000000,
      "resetAtMs": 1790288100000,
      "lastLimitSnippet": "You have hit your usage limit. …",
      "status": "waiting",
      "resumeAttempts": 0
    }
  }
}
```

State transitions per entry:

```
waiting → spawning → resuming → resumed
waiting → spawning → resuming → still_limited → waiting   (reset time refreshed)
waiting → spawning → resuming → failed                   (pane_missing / session_mismatch / spawn_failed / dialog_missing)
* → cancelled                                              (cancel intent)
```

The scheduler writes state atomically (write `state.json.<pid>.<ts>.tmp`, fsync, rename).
A crash mid-write leaves the previous file intact.

`HERDR_PLUGIN_STATE_DIR/intents/` holds per-event JSON "intent" files written by event
handlers. The scheduler drains them at the top of each tick and removes them on success.

`HERDR_PLUGIN_STATE_DIR/scheduler.pid` records the detached scheduler's pid. The startup
hook uses it to skip re-spawning when an instance is already running.

`HERDR_PLUGIN_STATE_DIR/scheduler.log` is the rolling JSON-lines log written by the
scheduler. Useful for diagnosing missed resumes and timezone parsing issues.

## Behavior on Herdr restart

Herdr snapshots pane layout, agent identity, and the agent session reference (`codex resume
<session-id>`) at every save. On restart:

1. Herdr restores the snapshot and the Codex session id for each pane that reported one.
2. The startup hook fires once Herdr's API socket is ready.
3. The startup hook spawns a fresh detached scheduler; if a previous scheduler pid is still
   alive it skips respawning.
4. The scheduler reads `state.json` and re-arms the schedule.
5. If a reset time has already passed, the next tick processes the entry immediately.

If a pending entry's pane id no longer matches a Codex pane (e.g. the user moved Codex to
a different machine), the scheduler marks it `failed` with `pane_missing`. The user can
manually re-run `resume-now` against the new pane.

## Verification without burning Codex quota

Set `dryRun: true` in `config.json`. The scheduler will run the full detection, preflight,
and post-resume read sequence, log every step, and record a `resumed` outcome, but it will
**not** split a new pane or run `codex resume`. Drop back to `dryRun: false` when ready.

To simulate a usage limit without Codex actually hitting one, edit the fixture under
`fixtures/codex-usage-limit-*.txt` and load it via `herdr pane report-metadata …` or by
running a one-off test (see `npm test`). Production code never reads from
`fixtures/` unless `simulationFixturePath` is set, and the production manifest does not
expose any knob that flips this on by accident.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Scheduler never spawns after `herdr plugin link` | Startup hook not re-run because Herdr was already running | Restart Herdr once |
| New resume pane is created but goal does not resume | The "Resume paused goal?" dialog showed, the plugin sent `1` + Enter, but Codex did not advance because the limit was still active | The plugin records `dialog_missing`; check `scheduler.log` and re-run `Codex Auto Resume: Resume now` after a few minutes |
| `session_mismatch` recorded in state | Codex session id changed (Codex rotated its session after the limit) | Run `Codex Auto Resume: Resume now` against the new pane; future detections will use the new id |
| `model_unknown` recorded | The status line no longer has a recognizable `model <quality>` token (very rare; typically happens after Codex applies a UI change) | Set `defaultCodexModel` in `config.json` or update the plugin's detector |
| `pane_missing` recorded | The pane was closed before the resume attempt | Re-open Codex and run `Resume now` |
| `spawn_failed: …` recorded | `herdr pane split` failed (no split allowed, layout locked, etc.) | Adjust the layout or set `splitDirection` in `config.json` |
| `state version mismatch` warning | Stored state has a future version | Restore the previous plugin version or clear the state file; v1 entries are otherwise preserved |

Use `herdr plugin log list --plugin codex.autoresume` for Herdr's view of plugin command
runs, and inspect `scheduler.log` for the scheduler's own JSON-lines output.

## Limitations

- Plugin v1 only ships the event hooks `pane.agent_detected` and `pane.agent_status_changed`.
  The Codex CLI TUI does not emit a structured "usage limit" event; the plugin reads recent
  pane text to detect limits. If Codex changes its on-screen phrasing, the detector may need
  new patterns.
- `pane.output_changed` is intentionally excluded from plugin hooks by Herdr (see `events.rs`
  in the Herdr repo), so the plugin does not subscribe to high-frequency output streams.
- The scheduler polls with `pollIntervalSeconds` (default 10s) of latency. Lower it for
  faster wake-ups at the cost of slightly more idle CPU.
- The plugin cannot observe Codex pane text from outside Herdr; the `pane read` command is
  the only authoritative source. Reading 120 rows adds a small amount of socket traffic per
  status-change event.
- Pane IDs persist across Herdr server restarts, but if Codex itself rotates its session
  id mid-quota (rare), the scheduler marks the entry `session_mismatch` until the user
  re-arms.
- The plugin assumes `codex` is on `PATH` for the spawned pane. Herdr inherits the outer
  pane's environment, so this is normally true, but custom CodeX builds need to be
  reachable through `codex` or via the user's shell.
- The plugin only ever spawns ONE resume pane per pending entry. A retry does not create
  additional panes; it instead reuses the previous resume pane id when possible. Pane
  cleanup is the user's responsibility — the plugin deliberately does not close the
  resumed Codex pane or the original (Luna Reserve) pane automatically.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run test           # node --test --import tsx ./test/*.test.ts
npm run build          # tsc -p tsconfig.build.json → dist/
```

The `HerdrClient` interface in `src/herdr.ts` is the seam the tests use; production uses
`CliHerdrClient` which shells out to the `herdr` binary via `HERDR_BIN_PATH`.

## License

MIT.
