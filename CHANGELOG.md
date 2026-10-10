# Changelog

All notable changes to **Antigravity System One (`agy-smart`)** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] - 2026-10-10

### Added
- **Auto `--effort` Allocation (TypeSafe Score Primitive)**:
  - Implemented `inferEffortLevel()` and `scoreToEffort()` in `index.mjs` using TypeSafe's typed `Score` primitive across 3 levels (low, medium, high).
  - Automatically assesses prompt reasoning complexity in <400ms and injects `--effort <low|medium|high>` into Antigravity CLI invocations.
  - Added `injectEffortArg()` to automatically assign effort while strictly preserving manual user flags when `--effort` is passed explicitly.
- **TDD Test Suite Expansion**:
  - Added unit and contract tests in `test.mjs` verifying threshold boundary mapping, offline fallback, and CLI flag preservation.

### Fixed
- **Hook Deduplication Stalling**:
  - Added direct execution auto-run guard in `hook.mjs` preventing `stdin` listener hang during module imports in test runners.
- **Cross-Conversation Collision Guard**:
  - Hardened `alreadyLogged()` to evaluate `(stepIndex, prompt)` tuples, preventing multi-conversation step collision.

---

## [1.2.0] - 2026-09-28

### Added
- **Hybrid Context-Aware Follow-Up Routing**:
  - Implemented `enrichShortPrompt()` in `index.mjs` and `hook.mjs`.
  - Automatically enriches prompts under 8 words or matching follow-up triggers (`continue`, `fix`, `why`, `next`, `redo`, etc.) with previous conversational turn context.
  - Prevents multi-turn coding sessions from prematurely falling back to `general_mode`.
- **Skill Sensitivity Multipliers (`skillWeights`)**:
  - Added configurable per-skill multipliers (`0.5x` to `1.5x`) in `agy-smart.config.json`.
  - Scaled effective probability formula: $\min(\text{round}(\text{rawP} \times \text{weight} \times 100) / 100, 1.0)$.
- **Interactive Skills Catalog & Matrix in Dashboard**:
  - Added inline sensitivity sliders and real-time multiplier badges to every skill card in `dashboard.mjs`.
  - Added instant persistence via `POST /api/config`.
  - Added an optional *Prior context* input field to the Interactive Live Prompt Bench.
- **`stepIndex` Deduplication in IDE Hook**:
  - Enhanced `hook.mjs` to track `step_index` from transcript JSONL.
  - Eliminates duplicate Jev API calls across multiple tool-execution steps in the same turn while accurately processing subsequent turns.

### Fixed
- **Placeholder Frontmatter Vulnerability**:
  - Hardened `scanSkills()` in `index.mjs` with an automatic fallback to markdown body text when a skill contains template boilerplate descriptions (e.g. `"One sentence - what this skill does"`).
  - Corrected description for `pitch-psychologist`.

---

## [1.1.0] - 2026-09-27

### Added
- **Web Performance Dashboard (`dashboard.mjs`)**:
  - Native zero-dependency HTTP server running at `http://localhost:3737`.
  - Real-time SVG speedometer gauges for response latency, token efficiency, and cumulative savings.
  - Historical telemetry audit log table with one-click log clearing.
  - Interactive live prompt test bench to inspect live Jev probability distributions.
  - Latency & token savings trend timeline chart.
- **Telemetry Streaming**:
  - Structured telemetry recording (`telemetry.json`) capturing prompt, matched skills, latency, and saved tokens.

---

## [1.0.0] - 2026-09-27

### Added
- **Initial Release of Antigravity System One (`agy-smart`)**:
  - High-speed System 1 classification using TypeSafe Jev Noul questions.
  - Automatic discovery of local workspace (`.agents/skills`) and global (`~/.gemini/config/skills`) skills.
  - Dynamic session-scoped `.agents/skills.json` generation (`include_only` / `exclude: [".*"]`).
  - Zero-token General Mode for conversation and general coding.
  - Resilient cleanup hooks restoring original configuration on exit, interrupt (`SIGINT`), or crash.
  - Windows PowerShell (`.ps1`), Command Prompt (`.cmd`), and Unix bash wrappers.
