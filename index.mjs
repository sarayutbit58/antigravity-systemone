#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ponytail: single-file zero-dependency wrapper for Antigravity CLI with TypeSafe Jev routing

// ─── .env loader ────────────────────────────────────────────────────────────
export function loadEnv() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [
    path.join(process.cwd(), ".env"),
    path.join(currentDir, ".env"),
    path.join(os.homedir(), ".gemini", "antigravity-cli", ".env"),
    path.join(os.homedir(), ".env"),
  ]) {
    if (fs.existsSync(p)) {
      try { process.loadEnvFile(p); } catch { /* ignore */ }
    }
  }
}
loadEnv();

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(
  os.homedir(), ".gemini", "antigravity-cli", "agy-smart.config.json"
);

const DEFAULTS = {
  threshold: 0.5,
  timeoutMs: 2000,
  maxSkills: 5,
  verbose: false,
};

/** @returns {{ threshold: number, timeoutMs: number, maxSkills: number, verbose: boolean }} */
export function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  // ponytail: env vars override file values; file values override defaults
  return {
    threshold: num(process.env.AGY_SMART_THRESHOLD) ?? file.threshold ?? DEFAULTS.threshold,
    timeoutMs: num(process.env.AGY_SMART_TIMEOUT_MS) ?? file.timeoutMs ?? DEFAULTS.timeoutMs,
    maxSkills: num(process.env.AGY_SMART_MAX_SKILLS)  ?? file.maxSkills ?? DEFAULTS.maxSkills,
    verbose:   bool(process.env.AGY_SMART_VERBOSE)    ?? file.verbose   ?? DEFAULTS.verbose,
  };
}

function num(v)  { return v != null ? Number(v) || undefined : undefined; }
function bool(v) { return v != null ? v === "true" || v === "1" : undefined; }

// ─── CLI flags ──────────────────────────────────────────────────────────────
/**
 * Parse agy-smart-specific flags out of argv, return the rest for agy.
 * @param {string[]} argv
 * @returns {{ verbose: boolean, dryRun: boolean, dashboard: boolean, agyArgs: string[] }}
 */
export function parseFlags(argv) {
  let verbose = false, dryRun = false, dashboard = false;
  const agyArgs = [];
  for (const arg of argv) {
    if (arg === "--verbose") { verbose = true; continue; }
    if (arg === "--dry-run")  { dryRun  = true; continue; }
    if (arg === "--dashboard" || arg === "dashboard") { dashboard = true; continue; }
    agyArgs.push(arg);
  }
  return { verbose, dryRun, dashboard, agyArgs };
}

/**
 * Extract the user prompt text from agy CLI arguments.
 * @param {string[]} args
 * @returns {string}
 */
export function extractUserPrompt(args) {
  for (let i = 0; i < args.length; i++) {
    if (["-p", "--print", "-i", "--prompt-interactive", "--prompt"].includes(args[i])) {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) return args[i + 1];
    }
  }
  return args.filter((a) => !a.startsWith("-")).join(" ").trim();
}

// ─── Skill scanner ──────────────────────────────────────────────────────────
/**
 * @typedef {{ name: string, description: string, dirPath: string }} SkillInfo
 */

/** @returns {SkillInfo[]} */
export function scanSkills(workspaceRoot = process.cwd()) {
  const homeDir = os.homedir();
  const searchRoots = [
    path.join(workspaceRoot, ".agents", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".gemini", "config", "skills"),
  ];

  const map = new Map();
  for (const rootDir of searchRoots) {
    if (!fs.existsSync(rootDir)) continue;
    try {
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || map.has(entry.name)) continue;
        const mdPath = path.join(rootDir, entry.name, "SKILL.md");
        if (!fs.existsSync(mdPath)) continue;
        try {
          const content = fs.readFileSync(mdPath, "utf8");
          const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (!fm) continue;
          const nameM = fm[1].match(/^name:\s*(.+)$/m);
          const descM = fm[1].match(/^description:\s*([>|-]?\s*[\s\S]*?)(?=\n[a-zA-Z0-9_-]+:|$)/m);
          const name = nameM ? nameM[1].trim().replace(/^['"]|['"]$/g, "") : entry.name;
          let desc = descM ? descM[1].replace(/^[>|-]\s*/, "").replace(/\r?\n\s*/g, " ").trim() : "";
          if (desc.length > 200) desc = desc.slice(0, 197) + "...";
          map.set(name, { name, description: desc || "No description.", dirPath: path.join(rootDir, entry.name) });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return Array.from(map.values());
}

// ─── Jev Router (Noul per-Skill, live query every run) ──────────────────────
/**
 * @param {string} userPrompt
 * @param {SkillInfo[]} skills
 * @param {{ threshold: number, timeoutMs: number, maxSkills: number }} config
 * @param {string} [apiKey]
 * @returns {Promise<{ matchedSkills: string[], probabilities: Record<string, number>, latencyMs: number, error?: string }>}
 */
export async function queryJevRouter(userPrompt, skills, config, apiKey = process.env.TYPESAFE_API_KEY || "") {
  const t0 = Date.now();
  const empty = (error) => ({ matchedSkills: [], probabilities: {}, latencyMs: Date.now() - t0, error });

  if (!apiKey)                      return empty("TYPESAFE_API_KEY not set");
  if (!skills.length || !userPrompt.trim()) return empty();

  // ponytail: build one Noul question per skill. Jev runs them in parallel inside a single request.
  const questions = {};
  for (const s of skills.slice(0, 200)) {
    questions[s.name] = {
      type: "noul",
      instructions: `Is this skill relevant to the user's request?`,
      criteria: {
        true: s.description,
        false: "Not relevant to the user's request",
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ state: userPrompt, model: "jev-latest", questions }),
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { matchedSkills: [], probabilities: {}, latencyMs, error: `HTTP ${res.status}: ${t}` };
    }

    const data = await res.json();
    const probabilities = {};
    const candidates = [];

    for (const [id, ans] of Object.entries(data?.answers ?? {})) {
      const p = ans?.noul ?? 0;
      probabilities[id] = p;
      if (p >= config.threshold) candidates.push({ name: id, prob: p });
    }

    // Sort by probability descending, then cap at maxSkills
    candidates.sort((a, b) => b.prob - a.prob);
    const matchedSkills = candidates.slice(0, config.maxSkills).map((c) => c.name);

    return { matchedSkills, probabilities, latencyMs };
  } catch (err) {
    clearTimeout(timer);
    return empty(err.name === "AbortError" ? `Timeout (>${config.timeoutMs}ms)` : err.message);
  }
}

// ─── skills.json lifecycle ──────────────────────────────────────────────────
export function createSkillsConfig(workspaceRoot, matchedSkills) {
  const agentsDir = path.join(workspaceRoot, ".agents");
  const skillsJsonPath = path.join(agentsDir, "skills.json");
  const originalContent = fs.existsSync(skillsJsonPath) ? fs.readFileSync(skillsJsonPath, "utf8") : null;
  fs.mkdirSync(agentsDir, { recursive: true });

  const configContent = matchedSkills.length > 0
    ? { entries: [
        { path: "~/.gemini/config/skills", include_only: matchedSkills },
        { path: ".agents/skills",          include_only: matchedSkills },
      ]}
    : { entries: [
        { path: "~/.gemini/config/skills", exclude: [".*"] },
        { path: ".agents/skills",          exclude: [".*"] },
      ]};

  fs.writeFileSync(skillsJsonPath, JSON.stringify(configContent, null, 2), "utf8");
  return { skillsJsonPath, originalContent };
}

export function restoreSkillsConfig(skillsJsonPath, originalContent) {
  try {
    if (originalContent !== null) fs.writeFileSync(skillsJsonPath, originalContent, "utf8");
    else if (fs.existsSync(skillsJsonPath)) fs.unlinkSync(skillsJsonPath);
  } catch { /* ignore */ }
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────
async function run() {
  const { verbose: flagVerbose, dryRun, dashboard, agyArgs } = parseFlags(process.argv.slice(2));

  // If dashboard flag is requested, launch web server
  if (dashboard) {
    const { startDashboardWithFallback } = await import("./dashboard.mjs");
    startDashboardWithFallback();
    return;
  }

  const cfg = loadConfig();
  const isVerbose = flagVerbose || cfg.verbose;
  const prompt = extractUserPrompt(agyArgs);

  let cleanupHook = null;

  if (prompt) {
    const skills = scanSkills();

    // ── Live Jev query on every run ──
    const result = await queryJevRouter(prompt, skills, cfg);

    // Save telemetry log for dashboard
    try {
      const { saveTelemetry } = await import("./dashboard.mjs");
      const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
      saveTelemetry({
        id: `cli-${Date.now()}`,
        timestamp: Date.now(),
        prompt,
        matchedSkills: result.matchedSkills,
        latencyMs: result.latencyMs,
        totalSkills: skills.length,
        tokensSaved,
        status: result.error ? "error" : (result.matchedSkills.length > 0 ? "specialized" : "general_mode"),
        probabilities: result.probabilities,
        error: result.error
      });
    } catch { /* ignore non-critical telemetry failure */ }

    if (result.error) {
      console.log(`\x1b[33m⚠️  [Jev Router] ${result.error} (${result.latencyMs}ms) -> Falling back to default skills\x1b[0m`);
    } else {
      if (isVerbose) {
        printProbabilities(result.probabilities, cfg.threshold);
        console.log(`\x1b[90m   Latency: ${result.latencyMs}ms | Threshold: ${cfg.threshold} | Max: ${cfg.maxSkills}\x1b[0m`);
      }

      if (result.matchedSkills.length > 0) {
        console.log(`\x1b[32m⚡ [Jev System 1] Matched skills: [${result.matchedSkills.join(", ")}] (${result.latencyMs}ms)\x1b[0m`);
      } else {
        console.log(`\x1b[36m⚡ [Jev System 1] General task. Skills excluded for max token savings. (${result.latencyMs}ms)\x1b[0m`);
      }

      if (!dryRun) {
        const { skillsJsonPath, originalContent } = createSkillsConfig(process.cwd(), result.matchedSkills);
        cleanupHook = () => restoreSkillsConfig(skillsJsonPath, originalContent);
      }
    }
  }

  if (dryRun) {
    console.log("\x1b[90m🛑 [dry-run] Exiting without launching agy.\x1b[0m");
    return;
  }

  // ── Cleanup hooks ──
  if (cleanupHook) {
    const once = () => { if (cleanupHook) { cleanupHook(); cleanupHook = null; } };
    process.on("exit", once);
    process.on("SIGINT",  () => { once(); process.exit(0); });
    process.on("SIGTERM", () => { once(); process.exit(0); });
    process.on("uncaughtException", (e) => { once(); console.error(e); process.exit(1); });
  }

  const child = spawn(process.platform === "win32" ? "agy.exe" : "agy", agyArgs, {
    stdio: "inherit",
    shell: false,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function printProbabilities(probs, threshold) {
  const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  console.log("\x1b[90m   ┌─ Jev Noul Probabilities ─────────────────────");
  for (const [name, p] of sorted) {
    const bar = "█".repeat(Math.round(p * 20)).padEnd(20, "░");
    const tag = p >= threshold ? "\x1b[32m ✓\x1b[90m" : "  ";
    console.log(`\x1b[90m   │ ${bar} ${(p * 100).toFixed(1).padStart(5)}%${tag} ${name}`);
  }
  console.log("   └────────────────────────────────────────────\x1b[0m");
}

// ── Auto-run guard ──
const currentFilePath = new URL(import.meta.url).pathname;
const invokedPath = process.argv[1]?.replace(/\\/g, "/");
if (invokedPath && currentFilePath.endsWith(invokedPath.replace(/^[A-Za-z]:/, ""))) {
  run().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
}
