<div align="center">
  <h1>my-agent</h1>
  <p><strong>Write AI agents in <code>.conf</code> — run anywhere.</strong></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  </p>
</div>

---

## Overview

```
my-agent run agent.conf          # CLI interactive
my-agent build agent.conf        # Package as executable
my-agent export agent.conf       # Export as Skill / MCP
```

Write a `.conf` file to define your AI agent. One config, many runtimes.

## Quick Start

```bash
git clone <repo> && cd my-agent
./install.sh          # macOS / Linux
# .\install.ps1       # Windows (PowerShell)

# Set your API key
export MY_AGENT_KEY="sk-your-key"

# Run an example
my-agent run examples/translator.conf
```

## .conf Format

Two styles — use whichever you prefer:

**Bracket style:**
```conf
[agent]
name = translator
desc = Professional translator

[prompt]
system = "You are a professional translation assistant."
welcome = "Enter text to translate."

[settings]
provider = openai
temperature = 0.3

[tools]
allow = web_search, current_time

[ui]
icon = 🌐
color = #22c55e
```

**Brace style:**
```conf
agent {
    name = "translator";
    desc = "Professional translator";

    prompt {
        system = "You are a professional translation assistant.";
        welcome = "Enter text to translate.";
    }

    settings {
        provider = "openai";
        temperature = 0.3;
    }
}
```

Key rule: **never store API keys, models, or base URLs in `.conf`** — these are injected at runtime via environment variables or CLI flags.

## CLI Commands

| Command | Description |
|---------|-------------|
| `run <file>` | Run an agent (interactive or one-shot with `-P`) |
| `build <file>` | Package as standalone executable (macOS / Windows / Linux) |
| `export <file>` | Export as Skill JSON or MCP server |
| `lint <file>` | Validate `.conf` syntax |
| `init [name]` | Scaffold a new agent config |
| `providers` | List all supported LLM providers |

### Run Examples

```bash
# Interactive mode
my-agent run my-agent.conf

# One-shot prompt
my-agent run my-agent.conf -P "Translate: Hello World"

# Custom provider
my-agent run my-agent.conf --provider deepseek
my-agent run my-agent.conf --provider ollama --base-url http://localhost:11434/v1

# With env vars (don't hardcode in .conf)
MY_AGENT_KEY=sk-xxx my-agent run my-agent.conf
```

### Build Executable

```bash
# Build for current platform
my-agent build my-agent.conf -o ./dist

# Build for specific target
my-agent build my-agent.conf -t win-x64 -o ./dist
my-agent build my-agent.conf -t linux-x64 -o ./dist
my-agent build my-agent.conf -t mac-arm64 -o ./dist
```

### Export

```bash
# Export as Skill
my-agent export my-agent.conf -f skill -o ./exports

# Export as MCP server
my-agent export my-agent.conf -f mcp -o ./exports

# Export all formats
my-agent export my-agent.conf -o ./exports
```

## Supported Providers

| Provider | Default Model | Auth |
|----------|--------------|------|
| `openai` | GPT-4o | Bearer token |
| `anthropic` | Claude 3.5 Sonnet | `x-api-key` |
| `google` | Gemini 1.5 Pro | Bearer token |
| `deepseek` | DeepSeek V3 | Bearer token |
| `ollama` | llama3 | None (local) |
| `openrouter` | auto | Bearer token |

## Built-in Tools

| Tool | Description | License |
|------|-------------|---------|
| `web_search` | Web search via DuckDuckGo | MIT (duck-duck-scrape) |
| `read_file` | Read files (cwd only) | Built-in |
| `write_file` | Write files (cwd only) | Built-in |
| `list_files` | List directory contents | Built-in |
| `execute_command` | Run shell commands | Built-in |
| `current_time` | Get current date/time | Built-in |

## Installation

### From source (macOS / Linux)

```bash
git clone <repo> && cd my-agent
./install.sh
```

### From source (Windows)

```powershell
git clone <repo>; cd my-agent
.\install.ps1
```

### Manual

```bash
git clone <repo> && cd my-agent
npm install
npm install -g .
```

### Uninstall

```bash
./uninstall.sh        # macOS / Linux
# npm uninstall -g my-agent
```

## Project Structure

```
my-agent/
├── bin/my-agent.js               # CLI entry point
├── src/
│   ├── conf/parser.js            # .conf parser
│   ├── runtime/                   # Engine, LLM, tools, session
│   └── commands/                  # CLI command implementations
├── examples/                     # Sample .conf files
├── install.sh / install.ps1      # Install scripts
├── uninstall.sh                  # Uninstall script
└── LICENSE                       # Apache 2.0
```

## Why .conf?

- **One format, multiple runtimes** — CLI, export, package
- **Secrets-free** — no keys, models, or URLs in config files
- **Composable** — mix sections, include files, override at runtime

## License

Apache 2.0 — see [LICENSE](LICENSE).
