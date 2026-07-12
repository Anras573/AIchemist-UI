# Agents & skills

Two complementary ways to shape how the AI works:

- An **agent** is a reusable system prompt — a persona or role ("feature developer", "code reviewer") selected per session.
- A **skill** is a reusable context pack — reference material or instructions toggled on per session, or attached to a single message.

## Agents

### Selecting an agent

Click the **agent picker** button next to the message input. The dropdown lists the agents available for the session's provider; selecting one persists it for the session (a bot badge appears on the session tab). On your next message, the agent's instructions take effect.

- The **eye icon** previews any agent's instructions read-only.
- The **pencil icon** and **New agent…** jump to **Settings → Agents**, where agents are created and edited.

### Agent files

Agents are plain Markdown files with frontmatter:

```markdown
---
name: my-agent
description: What this agent does
---
System prompt / instructions here.
```

An optional `model:` line in the frontmatter makes the agent always run on that model, overriding the session's model — handy for agents that need a stronger (or cheaper) model than your default. This works on every provider; if the model isn't available the turn falls back to the session model instead of failing.

### Where agents are discovered

| Provider | Locations |
|---|---|
| Claude | `~/.claude/agents/*.md`, plus agents built into the Claude Agent SDK |
| Copilot | `<project>/.agents/copilot-agents/*.md` and `~/.github-copilot/agents/*.md` |
| Others (Codex, Ollama, OpenAI-compatible) | Claude's agent files (shared) |

## Skills

### The Skills panel

Open the **Skills** tab in the session's right panel. Each card is a skill; the interactions are:

- **Click the card** — toggle the skill on/off for this session. Active skills' content is injected into the agent's context on every turn.
- **Eye icon** — view the skill's rendered Markdown.
- **Pencil icon** — edit (user-created skills only; plugin skills are read-only). Editing and **New Skill** happen in **Settings → Skills**.

A search box and source filter chips (project / global / plugin) help when you have many skills.

### Where skills come from

Skills are folders containing a `SKILL.md` (frontmatter with `name` and `description`, then the content). Three source tiers, in priority order — a project skill overrides a same-named global or plugin skill:

| Tier | Location |
|---|---|
| **Project** | `<project>/.agents/skills/<skill-name>/SKILL.md` |
| **Global** | `~/.claude/skills/` (Claude sessions) or `~/.agents/skills/` (Copilot sessions) |
| **Plugin** | Skills shipped by installed Claude / Copilot plugins |

Skills work on **all providers** — a skill you toggle on is injected regardless of which provider runs the turn.

## Slash commands

Type `/` in the message input to open the command palette:

- **Skills** — pick a skill to attach to *just this message* (a one-shot badge appears on the input; it doesn't change the session's toggled skills).
- **Built-in actions** — `/new` (new session), `/clear`, `/help`, `/agent` (pick an agent).
