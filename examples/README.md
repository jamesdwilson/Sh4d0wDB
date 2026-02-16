# Example Primer & Always Files

These are example identity files for ShadowDB's primer system. Copy them to your OpenClaw workspace, edit them to match your agent, and run setup.

## How to use

```bash
# Copy to your workspace
cp PRIMER.md ~/.openclaw/workspace/PRIMER.md
cp ALWAYS.md ~/.openclaw/workspace/ALWAYS.md

# Edit them (replace the example content with your own)
nano ~/.openclaw/workspace/PRIMER.md
nano ~/.openclaw/workspace/ALWAYS.md

# Run setup — it auto-detects both files
curl -fsSL https://raw.githubusercontent.com/jamesdwilson/Sh4d0wDB/main/setup.sh | bash
```

## What goes where?

**The litmus test:** if the agent violates this rule *before it has a chance to search memory*, is that a problem?

### PRIMER.md → injected on first turn only

Context the agent needs before its first thought, but that's fine to scroll out of the window in a long conversation:

- **Core identity** — name, personality, role
- **Owner basics** — who you are, where you live, key relationships
- **Communication style** — tone, formatting preferences
- **Work context** — company, role, tech stack
- **Key people** — names and relationships the agent should know immediately

The primer is your agent's "boot sequence." It reads this once, then it's in the conversation history. On turn 47, the model still has it from turn 1.

### ALWAYS.md → injected on every single turn

Rules so critical they can't risk scrolling out of context, even in a 200-turn conversation:

- **Safety gates** — "never send without confirmation" (if this scrolls out, the agent might auto-send)
- **Banned words** — terms you never want to see (the agent can't search for "what words am I not allowed to use" before using them)
- **Privacy constraints** — "never share Maya's school name" (one violation is one too many)

**Keep ALWAYS.md short.** Every line costs tokens on every turn. 3-5 rules is typical. If you have more than 10, most of them probably belong in PRIMER.md or as searchable memories.

### Everything else → searchable memories

The vast majority of your agent's knowledge should be in the `memories` table, not in primer files:

- Project details, meeting notes, preferences
- Historical context, decisions, lessons learned
- Behavioral rules that only apply in specific situations
- Reference material (contacts, accounts, procedures)

The agent searches for these when relevant. "How should I format emails?" triggers a search that finds your email formatting rule. It doesn't need to be in the primer because the agent naturally searches before composing an email.

## File format

Both files use the same format:

```markdown
# key-name
The rule or identity text goes here.
It can span multiple lines.

# another-key
Another rule. Each # heading becomes a key in the primer table.
Priority is assigned by order: first section = 0, second = 10, third = 20, etc.
```

- `# heading` → becomes the `key` column (lowercased, spaces→dashes)
- Body text → becomes the `content` column
- Order of appearance → becomes the `priority` (0, 10, 20, ...)
- Re-running setup with updated files overwrites existing entries (upsert)
