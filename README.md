# @mananjoshi/pi-session-plan

A session-scoped plan for semantic deliverables in Pi.

A session plan is the set of things this session committed to build — "build the
search bar", "import bookmarks". It is deliberately not a second Beads backlog
and not a checklist of verification commands.

## What it adds

- `session_plan` tool with `set`, `add`, `update`, `drop`, and `read` actions.
- Compact live widget showing `done/total` while the plan has open items.
- `/todos` command for the full keyboard-first plan view.
- Optional cmux status pill on the owning workspace.
- Branch-local plan reconstruction from tool results, so plans survive reload,
  tree switches, and compaction.

## Install

```bash
pi install npm:@mananjoshi/pi-session-plan
```

If the standalone `~/.pi/agent/extensions/session-plan.ts` extension is still
present, remove it after installing the package to avoid duplicate tool names.

## Use

The agent maintains the plan directly:

```text
session_plan set → add → update state=active → update state=done
```

`beadId` is only a reference to an existing Beads issue. This package never
creates, updates, or closes Beads issues.

Run `/todos` to inspect or edit the plan from the terminal.

## cmux

If `CMUX_WORKSPACE_ID` is set, the extension pushes a `plan-<session>` status
pill. cmux is optional; failures are ignored so the agent turn is never blocked.

## License

MIT
