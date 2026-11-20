# pi-session-plan

A tiny plan for the current Pi session.

The agent writes down what it promised to build. You see a small `2/4 done`
widget above the editor. Press `/todos` to see the whole list. That's the whole idea.

It is a sticky note on the current session — **not** a project tracker.

## The 10-second version

- **Agent:** calls `session_plan` to add, start, and finish deliverables.
- **Human:** sees a quiet progress strip and can open `/todos` anytime.
- **Pi:** keeps the plan in the session branch, so reloads and compaction don't erase it.
- **Beads:** untouched. A `beadId` is only a link.

```text
agent:  session_plan add → update state=active → update state=done
human:  /todos → inspect or edit the list
widget: plan  2/4 done
```

Good plan items are things like `Build the search bar` or `Import bookmarks`.
Bad plan items are commands like `Run tests` or `Check lint`.

## Why this exists

Beads, GitHub issues, and Linear are durable work trackers. They answer "what
does the project need?"

This plan answers a smaller question: **"what did this session promise to do?"**

It lives in the session branch, so it survives reloads, tree switches, and
compaction without creating another database on disk.

## What you get

- a `session_plan` tool for the agent
- a small live widget showing `done/total`
- a `/todos` command for the full view
- optional cmux status, only when `CMUX_WORKSPACE_ID` is present
- no writes to Beads and no background daemons

## Install

Once published:

```bash
pi install npm:@mananjoshi/pi-session-plan
```

For local testing:

```bash
pi install /path/to/pi-session-plan
```

If you still have the standalone `~/.pi/agent/extensions/session-plan.ts` file,
remove it after installing this package. Otherwise Pi will load the same tool
twice.

## For humans

Run `/todos` while a plan is active.

You will see a compact list like:

```text
Session plan 01a1f734 — 2/4 done

❯ ✓ t1 Build the search bar
  ◐ t2 Import bookmarks
  ○ t3 Write the empty state
  ○ t4 Ship the settings page
```

Keys:

| Key | Action |
| --- | --- |
| `↑` / `↓` | move |
| `Enter` | toggle done / planned |
| `s` | mark active |
| `a` | add a deliverable |
| `e` | edit title |
| `b` | link or clear a Beads id |
| `d` | drop an item |
| `Esc` | close |

Dropped items stay visible with a strikethrough-style marker. They can be
restored by toggling them back.

The widget disappears when there is no active plan, so it does not become wallpaper.

## For agents

Use `session_plan` to maintain a short list of user-visible deliverables.

Good items:

- `Build the search bar`
- `Import bookmarks`
- `Write the empty state`
- `Add share-sheet capture`

Bad items:

- `Run typecheck`
- `Run tests`
- `Check lint`
- `Commit and push`

Verification commands are gates, not deliverables. Put them in your own working
process, not in this plan.

### Actions

| Action | Use |
| --- | --- |
| `set` | create or replace the whole plan; requires `replace=true` if non-empty |
| `add` | add one deliverable |
| `update` | change title, state, note, or Beads link |
| `drop` | mark an item as no longer planned |
| `read` | return the current plan as text |

Example:

```text
session_plan set:
  - title: Build the search bar
  - title: Import bookmarks
  - title: Write the empty state
```

As work moves:

```text
session_plan update id=t1 state=active
session_plan update id=t1 state=done
```

### State model

| State | Meaning |
| --- | --- |
| `planned` | committed but not started |
| `active` | being worked on now |
| `done` | delivered |
| `dropped` | no longer planned; still visible for context |

Only one or two items should be active at a time. If everything is active,
nothing is.

### Beads boundary

A `beadId` is a reference only. This package never creates, updates, or closes
Beads issues. Beads remains the durable project tracker; `session_plan` is this
session's live state.

## cmux

If `CMUX_WORKSPACE_ID` is set, the extension pushes a `plan-<session>` status pill
to the owning cmux workspace and clears it on shutdown or when no work remains.
cmux is optional; failures are ignored so they never break an agent turn.

## License

MIT
