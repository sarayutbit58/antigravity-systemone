# Contributing to `agy-smart`

Thank you for your interest in contributing to **Antigravity System One (`agy-smart`)**!

This project prioritizes high performance, zero external runtime dependencies, and rock-solid reliability.

---

## 🛠️ Development Setup

### Prerequisites
- **Node.js** `>= v20.6.0` (required for native `process.loadEnvFile` and ESM support)
- **Google Antigravity CLI** (`agy`) installed
- **TypeSafe API Key** ([Sign up at TypeSafe](https://typesafe.ai))

### 1. Clone & Link Locally
```bash
git clone https://github.com/sarayutbit58/antigravity-systemone.git
cd antigravity-systemone
npm install
npm link
```

### 2. Configure Local Environment
Create `.env` from `.env.example`:
```bash
cp .env.example .env
```
Inside `.env`:
```env
TYPESAFE_API_KEY=your_typesafe_api_key_here
```
> [!CAUTION]
> **Never commit your `.env` file or API keys.** The repository has strict gitignore rules and pre-commit checks in place to prevent credential leaks.

---

## 🧘 Code Style & Design Guidelines ("Lazy Senior Dev Mode")

`agy-smart` adheres strictly to efficient, minimal-code principles:

1. **Zero External Dependencies**:
   - Do not install npm packages for runtime logic.
   - Use Node.js built-ins (`node:http`, `node:fs`, `node:path`, `node:os`, `node:child_process`).
2. **Shortest Working Diff**:
   - The best code is the code never written. Solve problems at the root cause rather than patching symptoms across multiple callers.
3. **No Unrequested Abstractions**:
   - Keep files flat and simple. Avoid unnecessary classes or middleware layers.
4. **Mark Simplifications**:
   - Mark intentional heuristics or shortcuts with a `// ponytail:` comment describing the shortcut and ceiling.

---

## 🧪 Running Verification Tests

Before submitting any changes, all assertion suites must pass:

```bash
# Run CLI & Router unit tests
npm test

# Run Web Dashboard API tests
node test-dashboard.mjs
```

### Writing New Tests
- Keep tests lightweight using `node:assert/strict`.
- Avoid heavyweight test frameworks; self-contained, runnable check files are preferred.

---

## 📦 Pull Request Process

1. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes with conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`).
3. Ensure all tests pass.
4. Open a pull request against `main` on [GitHub](https://github.com/sarayutbit58/antigravity-systemone).
