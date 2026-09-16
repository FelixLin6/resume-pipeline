# Daily scheduler task (live id: task-mtkei5b8-z2z1wf)

Schedule: daily 13:15 America/Los_Angeles (4:15pm ET, after Simplify mail cutoff)

> **2026-09-15 (Felix):** the main session no longer chains the stages
> itself. It launches ONE `pipeline-orchestrator` subagent (Opus 5 medium,
> `agent/pipeline-orchestrator.md`) which spawns the stage agents itself —
> nested subagent spawning works on the current Claude Code runtime. The
> full stage-by-stage orchestration text now lives in the agent file, not
> in this prompt.

## Prompt

[Daily resume drops] Orchestrate today's run by launching ONE background 'pipeline-orchestrator' subagent (Opus 5, medium effort; Felix 2026-09-15 — orchestration lives in that subagent now, not the main session; it spawns jd-list / job-applier xN / jd-reconcile itself per ~/zylos/.claude/agents/pipeline-orchestrator.md and SKILL.md "Daily pipeline"). If subagent_type 'pipeline-orchestrator' is not registered in this session, fall back to subagent_type 'general-purpose' with model 'opus', prepending: "First read ~/zylos/.claude/agents/pipeline-orchestrator.md and obey it as your system instructions (medium effort)." Orchestrator prompt: "Run today's full daily pipeline (Stages 1 -> 1.5 -> 2 -> 2.5 -> 3) per your agent definition; host = Mac (sync local); no deadline unless Felix set one; return the compact report." Do NOT run pipeline work inline and do NOT spawn stage agents yourself — stay responsive to other messages while it runs. When the orchestrator returns, sanity-check its report (README pushed? DM sent? coverage clean? browser stopped?) and only then mark this occurrence done. If the orchestrator dies, relaunch it once; if it fails twice, run the day via ONE 'resume-pipeline' solo fallback subagent and tell Felix the orchestrated path failed. If Chrome is left running after a failure, run ~/zylos/.claude/skills/resume/scripts/pipeline-browser.sh stop yourself.
