---
name: ulw-orca
description: Visualize an OMO ulw-plan for human approval, then hand the approved plan to a new OMO execution terminal through Orca.
---

# Plan review and execution handoff

Use in the planning session after `ulw-plan` has written and reviewed a plan,
or when the user requests `ulw-orca <slug>`. This skill only renders the plan
and connects approval to execution. OMO owns subsequent goals, worktrees,
delegation, verification, model fallback, and completion.

Resolve the scripts relative to this skill's installed location. Run with
Node 22+ in the target repository; pass `--root <absolute-project-path>` when
the shell cwd differs. Install this folder into `.agents/skills/ulw-orca/`
or `~/.agents/skills/ulw-orca/` for OMO native discovery. For automatic connection
after planning, copy [the rule](rules/ulw-orca.md) to `.omo/rules/ulw-orca.md`
in the adopter project. Do not overwrite an existing rule without reconciling it.

## Review

1. Select the slug from the user's argument, the plan just written in this
   session, or the only file under `.omo/plans/`. Ask once if ambiguous; if none
   exists, route to `ulw-plan`.
2. Run `node <skill>/scripts/plan-review.mjs <slug> --serve` in the background.
   Read the returned URL, load the version-matched Orca CLI guide, and open it
   using `orca goto --url <url> --json` (use the session's resolved Orca binary).
   Print `templates/hints.json`'s `review` sentence. If the browser is unavailable,
   give the local HTML path and URL. No page or plan is uploaded.
3. Wait for the server's completion notification; read
   `.omo/ulw-orca/<slug>/review.json`. The server also exits when a chat decision
   is saved. On explicit chat `approve`, record it with
   `node <skill>/scripts/plan-review.mjs <slug> --decision approve`.
   Never run that command on the user's behalf before their approval.
4. A decision containing notes, vetoes, or added exclusions is a change request,
   including when submitted with Approve. Resolve vetoes with the user, apply
   notes and scope changes to the plan, run its normal OMO plan review, and
   render again. Preserve the submitted feedback until it has been applied.
   Approval refers to the displayed plan and draft contents; edits require a
   new review. Do not modify a plan after approval and then launch it silently.

## Connect execution

After a clean approval, run:

`node <skill>/scripts/launch.mjs <slug>`

The helper creates one terminal in the same Orca-managed checkout, waits for
TUI readiness, and delivers the plan to `ulw-execute`. Let OMO create and manage
its own worktrees. Intermediate work integrates directly; the handoff requests
one final PR and no merge without explicit authorization.

Model selection stays with the user's OMO settings. To select an existing
configuration profile, pass `--profile <name>`; this only sets `OMO_PROFILE`.
There is no model flag, budget, supervisor, timeout-driven rotation, or goal
state writer. See [runtime notes](references/runtime.md) for shell selection,
startup issues, receipt recovery, and validation limits.

When the helper returns `accepted: true`, report its `hint` and terminal handle,
then end the planning turn. Input acceptance is the handoff result; do not claim
implementation has completed or monitor the execution session.
