# dsh-llm-agy

> **AGY (Antigravity CLI) — the agent-boosting engine for DeepSeek Harness**
> Seamlessly integrate Google's AI coding agent Antigravity (powered by Gemini)
> into dsh: independent reasoning subagents, deep web search, and one-click
> connectivity diagnostics. Plug-and-play, zero source changes.

---

## 1. What it is

**dsh-llm-agy** is an open-source plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh) that connects Google's AI coding agent **Antigravity CLI**(AGY, based on Gemini) to the dsh ecosystem, adding three independent enhancement channels to your workflow:

| Capability | Description |
| --- | --- |
| **Independent reasoning subagents** | Delegate frontend/UI, visual review and other tasks to AGY-driven subagents (Gemini 3.7 Flash High), running alongside your main agent; long-lived sessions are reusable |
| **Deep web search** | The `web_search` tool performs **complete deep research** through AGY's Google search channel — search, open sources, read full content, synthesize an answer — not just a link list |
| **Connectivity diagnostics panel** | An AntiGravity card inside dsh Settings → Plugins: check local install & login status, run a real connectivity test, copy install commands for every platform with one click |

The plugin strictly follows dsh's official extension mechanisms (profile bundle patch / `registerModelDiscovery` / `registerSearchProvider` / client slots). **No dsh source code is modified**, so it keeps working across dsh upgrades.

## 2. Core features

### 2.1 Independent reasoning subagents (provider route `agy`)

Your main agent can delegate tasks to AGY — a second brain with its own reasoning chain and tool surface:

- Switch any subagent to AGY reasoning via `agentOptions.provider: 'agy'`
- Built-in tools: `subagent_agy_ui` (frontend/UI design, styling research, visual implementation, screenshot verification; continuable long-lived sessions) and `subagent_agy_vision` (image reading, mockup analysis; one-shot)
- Split complex tasks into independent sub-tasks, schedule subagents in parallel, then merge the results

### 2.2 Deep web search (search provider `agy`)

Upgrade dsh's `web_search` tool from "return a link list" to "complete deep research":

- Searches via AGY's `search_web` (Google)
- AGY autonomously: searches → opens each source and reads the full content → writes an accurate, complete, cited answer
- The reply language follows the query language; nothing is written to the session
- One-line switch: `web.searchProvider = 'agy'`

### 2.3 Connectivity diagnostics panel (Settings → Plugins → AntiGravity)

Full AGY environment check without touching a terminal:

- **Install / login check**: one click confirms whether AGY is installed and signed in
- **Connectivity test**: sends a real prompt and shows AGY's actual reply
- **Install commands**: Windows (winget) / macOS (Homebrew) / Linux (curl) / npm — one-click copy
- **Tool reference**: quick reference for the bundled tools
- The panel interacts through the official model-discovery channel (`api.llm.discoverModels`); **no session is consumed**

## 3. Quick start

### Requirements

- dsh (web profile; npx or source build)
- Node.js ≥ 20
- AGY CLI (see install commands below)

### Install the plugin

```bash
# Via npm (after publish)
npx @deepseek-ai/dsh plugin --profile web add @dsh-external/dsh-llm-agy

# From source
git clone https://github.com/flg1217/dsh-llm-agy.git
cd dsh-llm-agy
pnpm install && pnpm build
node scripts/link-profile.mjs
```

After installation, **restart dsh web**, open **Settings → Plugins → AntiGravity**, expand the card and click "Check install/login" to confirm the environment is ready.

### Install AGY (Antigravity CLI)

```bash
# Windows
winget install --id Google.Antigravity

# macOS
brew install --cask antigravity

# Linux / macOS (generic)
curl -fsSL https://antigravity.google/install | bash

# Or npm global
npm install -g @antigravity/cli
```

Official docs: https://antigravity.google/docs/cli/install

### Configuration

| Option | Default | Description |
| --- | --- | --- |
| `command` | `agy` | AGY executable command |
| `model` | `gemini-3.7-flash-high` | Reasoning model |
| `effort` | `high` | Reasoning effort (low / medium / high) |
| `proxy` | `http://127.0.0.1:7890` | Traffic proxy (empty string disables) |

Editable in the settings panel, or in the profile's `cordis.patch.yml`.

## 4. Typical usage

### Web search via AGY deep research

```yaml
# profile patch (~/.dsh/profiles/web/cordis.patch.yml)
- id: web
  config:
    searchProvider: agy
```

After this, `web_search` returns AGY's deep-researched answer with cited sources.

### Subagent delegation to AGY

Configure in an agent preset or tool row:

```yaml
- id: tool-subagent-agy-ui
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_agy_ui
    agentOptions:
      provider: agy            # reasoning done by AGY/Gemini
      model: gemini-3.7-flash-high
```

Frontend/UI tasks: delegate to `subagent_agy_ui` — design, implementation and screenshot verification by an independent Gemini model. Image-reading tasks: delegate to `subagent_agy_vision` (one-shot per call).

### CLI diagnostics

```bash
/agy status        # check AGY install & login status
/agy test          # run a real test, show AGY's reply
/agy               # help
```

## 5. How it works

The plugin is dual-faced and assembled through dsh's official extension points:

```
┌─────────────── Host process (node half) ──────────────┐
│ index.ts    plugin entry                              │
│ adapter.ts  AgyLlmAdapter — spawn agy reasoning       │
│ search.ts   ctx.web.registerSearchProvider            │
│ settings.ts settings + registerModelDiscovery         │
└───────────────────────────────────────────────────────┘
┌─────────────── Browser (web half) ────────────────────┐
│ client/index.js  settings.plugin.item card            │
│                  reuses official components & styles   │
└───────────────────────────────────────────────────────┘
```

- **Assembly**: `cordis.patch.yml` (bundle patch) + `dsh.bundle`/`dsh.client` manifest in package.json; `dsh plugin add` does it all
- **Reasoning**: the server spawns the AGY CLI (stream-json protocol); live streaming output and token stats are rendered by the dsh harness
- **Search**: `search()` calls AGY directly, which autonomously retrieves and synthesizes
- **Panel**: status/test probes go through the official `api.llm.discoverModels` channel; the server executes and the result returns to the panel — **no session writes, no dsh source changes**

## 6. Development

```bash
git clone https://github.com/flg1217/dsh-llm-agy.git
cd dsh-llm-agy
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

See [docs/CONTRIBUTING.zh.md](docs/CONTRIBUTING.zh.md).

## 7. License

[MIT](LICENSE)
