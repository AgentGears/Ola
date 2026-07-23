---
memory_id: lesson/session_skill_conversion.md
lesson_name: session_skill_conversion
retrieval_anchor: "Stage: terminal; Boundary: skill markdown converted from prompt-template; Capability: migrate legacy agent prompts to skills"
domain: skill_authoring
tags: [skill, markdown, prompt, conversion, frontmatter, SKILL.md]
outcome: success
shape: l2_like
sidecar_stats:
  confidence: 0.7
  last_used: "-4d"
  consolidation_count: 1
  used_count: 3
  created_at: "-12d"
---

# Session: Skill Conversion

What changed: converted `prompts/roasting.md` (legacy prompt template) to
`skills/roasting/SKILL.md` with proper YAML frontmatter and `description` field.

Why: agent framework changed — prompts now loaded as skills with metadata.
Old prompt format silently ignored.

How verified:
- `/roasting` slash-command invokes the new skill (verified in test session)
- `description` field appears in skill listing
- `SKILL.md` validates against the skill schema (frontmatter + body structure)

Files touched: `skills/roasting/SKILL.md` (new), `prompts/roasting.md` (removed).
Tool used: `Read`, `Write`, `Skill` invocation to test.
Error string seen during failed attempts: `Error: skill name 'roasting' not found in available-skills list`.
