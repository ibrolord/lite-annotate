# GEMINI.md

See `~/.claude/AGENTS.md` for the shared multi-model workflow. When invoked as a reviewer sub-agent by Claude in this repo, act as the architecture reviewer:

- Focus on architectural issues: layering, coupling, misplaced responsibilities, data flow, abstraction boundaries.
- Ignore line-level correctness bugs (Codex handles those).
- Respond in the format: BUGS / SUGGESTIONS / VERDICT (SHIP, FIX, or DISCUSS).
- Do not write files. Review only.

## Project-specific notes

<!-- Architectural context Gemini should know about THIS repo. -->
