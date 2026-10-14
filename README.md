# pi-auto-rename

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

> A cheap model turns your first prompt into a short, searchable name for each unnamed, persisted interactive [Pi](https://github.com/earendil-works/pi) session

After the first turn, this extension takes your opening prompt, asks a small, configurable model to summarize it into a 3–8 word title, and sets it as the session name.

Without it, pi's `/resume` picker falls back to showing each session's raw first prompt — fine for a one-liner, useless when the opening message is a pasted stack trace, a long spec, or a skill invocation, since you only see a truncated fragment:

```text
TypeError: Cannot read properties of undefi…   42 3h
kitchen-sink Review the draft README and tell…  7 2d
```

With it, every session gets a short, searchable title instead:

```text
Fix WebSocket reconnect race                   42 3h
Debug flaky Vitest snapshot                     7 2d
```

## How it works

```text
┌─────────────────┐  first prompt   ┌────────────────┐
│  user's opening │ ──────────────▶ │  naming model  │
│  prompt         │                 │  (configurable)│
└─────────────────┘                 └───────┬────────┘
                                            │  3–8 word title
                    ┌───────────────────────▼────────┐
                    │ pi.setSessionName("Fix         │
                    │   WebSocket reconnect race")   │
                    └────────────────────────────────┘
```

- **When it fires** — in the interactive TUI only, once per session, on `agent_end` after the first turn, and only if the session has no name yet. `/reload` re-runs the extension but the existing-name guard prevents a second naming run.
- **When it doesn't fire** — one-shot modes (`-p` / `--print`, `--mode json`, `--mode rpc`, and implicitly piped runs), `--no-session`, and any session that already has a name. That last guard is what makes explicit `--name <x>` respected: the user's name is never replaced.
- **Why interactive only** — one-shot runs are scripted; naming burns a model call per invocation and the sessions are usually throwaway. Named sessions only matter for the `/resume` picker, which people use interactively.
- **Why a name** — named sessions are searchable in the `/resume` picker (and survive Ctrl+N's named-only filter), and the terminal title becomes `pi - <session name> - <cwd>` instead of just `pi - <cwd>`.
- **Model pick** — uses the model pinned in the config file. Without a config, it picks the cheapest available model by input token cost (respecting session model scoping via `enabledModels` / `--models`), falling back to the active session model.
- **Non-blocking** — naming runs in the background so the prompt is never delayed (it never delays anything: it only runs in the interactive TUI).
- **One name per fresh session** — `/new` and `/fork` inside a TUI run reset the guard, so each fresh session gets its own naming run from its own first prompt.

## Install

```bash
pi install npm:@summer-tt/pi-auto-rename
```

Alternatively, install directly from the Git repository:

```bash
pi install git:github.com/summer-tt/pi-auto-rename
```

The repository root is a Pi package: `package.json` declares
`pi.extensions: ["./auto-session-name.ts"]`. Pi loads the TypeScript source
without a build step; the Pi host supplies the peer dependencies.

For local development, from this repository root:

```bash
pi install .
```

Remove the package with:

```bash
pi remove npm:@summer-tt/pi-auto-rename
```

That's it — start a session, and after the first agent turn it gets a name. No commands, no flags.

## Configuration

Config file `~/.pi/agent/auto-session-name.json` pins the naming model and request options:

```json
{
  "provider": "google",
  "model": "gemma-4-26b-a4b-it",
  "temperature": 0.2,
  "thinking": "off"
}
```

- `provider`, `model` — pin the naming model (required keys).
- `temperature` — sampling temperature passed to the naming request as-is. Must be between 0 and 2; values outside that range (or non-numbers) are treated as malformed and repaired away. Omitted by default (provider default applies). Providers may drop it where they forbid it (Anthropic ignores it when thinking is enabled, and only accepts 0–1).
- `thinking` — reasoning level for the naming request: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Defaults to `"off"`. The level is clamped to what the model supports (model-specific level mappings are respected).

The file is read at naming time, so edits apply on the next session — no reload required. When a file is generated or repaired (see below), the rewrite is schema-normalizing: only `provider`, `model`, `temperature`, and `thinking` are kept, so any extra keys are dropped.

### Self-healing config

The config file repairs itself, with three levels of intervention:

| File state                                                         | What happens                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Missing                                                            | Generated on first use, pinning the default model pick (see above)             |
| Unusable (unparseable JSON, or missing/invalid `provider`/`model`) | Regenerated from the default pick, with a warning                              |
| Valid `provider`/`model`, but malformed `temperature`/`thinking`   | Those fields are dropped and the file is rewritten in place, keeping the model |
| Valid                                                              | Never overwritten                                                              |

Missing keys are simply left unset (defaults apply).

> [!TIP]
> The generated file is a starting point for your edits — pin a tiny, fast model like Gemma or a mini-tier model to keep naming cheap and instant.

> [!NOTE]
> A configured model that is unknown or has no configured credentials falls back to the default pick (with a warning).

## Behavior notes

- Naming is best-effort. Quitting, switching sessions, or reloading before the background request finishes can prevent the name from being applied.
- Everything the config file touches happens inside a naming run, so file generation and self-healing only occur in interactive sessions — a purely scripted (`-p`) usage never creates the config file.
- Failures and config problems are logged to the terminal (`[auto-session-name] ...`), never surfaced in the UI.
- The naming call passes the session id, which opencode gateways require: without it they reject the call with `400 MissingSessionID` and the session silently stays unnamed (pi-ai derives `x-opencode-session` from it since 0.87.1).
- The naming prompt requests a single-line plain-text title without Markdown, quotation marks, labels, or explanations; model compliance is not guaranteed.
- Automatic titles are normalized at their boundaries: surrounding ASCII quotes and all boundary asterisks (even unpaired ones) are stripped, along with exact paired outer underscores (`_` or `__`), single or double backticks, and `~~`. Nested wrappers are stripped until stable. Internal characters are preserved; this is not a general Markdown parser, and fences or asymmetric non-asterisk wrappers are left alone. Boundary literals such as `C*`, `*.ts`, and `__init__` become `C`, `.ts`, and `init`.
- An empty normalized result leaves the session unnamed, without another naming attempt in the same extension lifecycle. Explicit user names never pass through this normalization.

## Origin and license

Extracted from the `auto-session-name/` directory of
`summer-tt/pi-agent-extensions` (the retired fork)
at commit `776a45e5f1a4508f1352c85855f257a310a26c3c` (extension version `0.3.1`).
The original project is
[`TinySquid/pi-agent-extensions`](https://github.com/TinySquid/pi-agent-extensions).

The extension source is preserved unchanged, including the title-normalization
fix from the summer-tt fork. Only packaging and documentation were adapted for
this standalone distribution. The npm package published from this repository is
`@summer-tt/pi-auto-rename`; it does not publish or replace the upstream npm
package `@tinysquid/pi-auto-session-name`.

MIT licensed; the original TinySquid copyright notice is preserved in [LICENSE](LICENSE).
