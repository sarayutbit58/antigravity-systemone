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
  skillWeights: {},
};

/** @returns {{ threshold: number, timeoutMs: number, maxSkills: number, verbose: boolean, skillWeights: Record<string, number> }} */
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
    skillWeights: typeof file.skillWeights === "object" && file.skillWeights !== null ? file.skillWeights : DEFAULTS.skillWeights,
  };
}

function num(v)  { return v != null ? Number(v) || undefined : undefined; }
function bool(v) { return v != null ? v === "true" || v === "1" : undefined; }

/** @param {Partial<{ threshold: number, timeoutMs: number, maxSkills: number, verbose: boolean, skillWeights: Record<string, number> }>} updates */
export function saveConfig(updates = {}) {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  // ponytail: sanitize skillWeights - only keep finite numbers clamped to [0.1, 2.0], allow null to delete
  const cleanedWeights = { ...(file.skillWeights ?? {}) };
  if (typeof updates.skillWeights === "object" && updates.skillWeights !== null) {
    for (const [k, v] of Object.entries(updates.skillWeights)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        cleanedWeights[k] = Math.max(0.1, Math.min(Math.round(v * 10) / 10, 2.0));
      } else if (v === null || v === undefined) {
        delete cleanedWeights[k];
      }
    }
  }

  const merged = {
    threshold: typeof updates.threshold === "number" && Number.isFinite(updates.threshold)
      ? Math.min(Math.max(Number(updates.threshold), 0.05), 0.95)
      : (file.threshold ?? DEFAULTS.threshold),
    timeoutMs: typeof updates.timeoutMs === "number" && Number.isFinite(updates.timeoutMs)
      ? Math.min(Math.max(Math.round(Number(updates.timeoutMs)), 200), 10000)
      : (file.timeoutMs ?? DEFAULTS.timeoutMs),
    maxSkills: typeof updates.maxSkills === "number" && Number.isFinite(updates.maxSkills)
      ? Math.min(Math.max(Math.round(Number(updates.maxSkills)), 1), 20)
      : (file.maxSkills ?? DEFAULTS.maxSkills),
    verbose: typeof updates.verbose === "boolean" ? updates.verbose : (file.verbose ?? DEFAULTS.verbose),
    skillWeights: cleanedWeights,
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Pure algorithmic sensitivity auto-calibration engine.
 * Evaluates empirical telemetry history to calculate balanced sensitivity multipliers.
 *
 * @param {Array<object>} [logs=[]] - Historical telemetry entries
 * @param {Record<string, number>} [currentWeights={}] - Current skill weights from config
 * @param {object} [options={}] - Options (e.g. threshold, skills)
 * @returns {{
 *   totalEvaluated: number,
 *   skillWeights: Record<string, number>,
 *   deltas: Record<string, { current: number, recommended: number, delta: number, reason: string, metrics: { hits: number, hitRate: number, fpRatio: number, scr: number, nearMisses: number } }>,
 *   recommendations: Record<string, object>,
 *   stats: { boosted: number, dampened: number, unchanged: number }
 * }}
 */
export function calibrateSkills(logs = [], currentWeights = {}, options = {}) {
  const safeOptions = (options && typeof options === "object" && !Array.isArray(options)) ? options : {};
  const safeWeights = (currentWeights && typeof currentWeights === "object" && !Array.isArray(currentWeights)) ? currentWeights : {};
  const threshold = typeof safeOptions.threshold === "number" && Number.isFinite(safeOptions.threshold)
    ? safeOptions.threshold
    : 0.5;

  const validLogs = Array.isArray(logs)
    ? logs.filter((l) => l && typeof l === "object")
    : [];
  const totalEvaluated = validLogs.length;
  const deltas = {};
  const recommendedWeights = {};
  let boosted = 0, dampened = 0, unchanged = 0;

  // Gather unique skill set
  const skillNamesSet = new Set();
  if (Array.isArray(safeOptions.skills)) {
    for (const s of safeOptions.skills) {
      if (typeof s === "string") skillNamesSet.add(s);
      else if (s && typeof s.name === "string") skillNamesSet.add(s.name);
    }
  } else {
    try {
      const scanned = scanSkills();
      for (const s of scanned) skillNamesSet.add(s.name);
    } catch { /* ignore */ }
  }
  for (const k of Object.keys(safeWeights)) {
    skillNamesSet.add(k);
  }
  for (const log of validLogs) {
    if (Array.isArray(log.matchedSkills)) {
      for (const s of log.matchedSkills) skillNamesSet.add(s);
    }
    if (log.probabilities && typeof log.probabilities === "object") {
      for (const s of Object.keys(log.probabilities)) skillNamesSet.add(s);
    }
  }

  const isSparse = totalEvaluated < 3;
  const sampleConfidence = Math.min(1.0, totalEvaluated / 15);

  for (const skill of skillNamesSet) {
    const rawCurr = safeWeights[skill];
    const curr = typeof rawCurr === "number" && Number.isFinite(rawCurr)
      ? Math.max(0.1, Math.min(Math.round(rawCurr * 10) / 10, 2.0))
      : 1.0;

    if (isSparse) {
      deltas[skill] = {
        current: curr,
        recommended: curr,
        delta: 0.0,
        reason: totalEvaluated === 0
          ? "No telemetry data recorded yet"
          : "Insufficient telemetry samples (< 3) for calibration",
        metrics: { hits: 0, hitRate: 0, fpRatio: 0, scr: 0, nearMisses: 0 }
      };
      recommendedWeights[skill] = curr;
      unchanged++;
      continue;
    }

    let hits = 0;
    let borderlineHits = 0; // P in [threshold, threshold + 0.15)
    let strongHits = 0;     // P >= threshold + 0.20
    let nearMisses = 0;     // P in [threshold - 0.15, threshold)

    for (const log of validLogs) {
      const isMatched = Array.isArray(log.matchedSkills) && log.matchedSkills.includes(skill);
      let prob = null;
      if (log.probabilities && typeof log.probabilities[skill] === "number") {
        prob = log.probabilities[skill];
      }

      if (isMatched) {
        hits++;
        if (prob != null) {
          if (prob < threshold + 0.15) {
            borderlineHits++;
          }
          if (prob >= threshold + 0.20) {
            strongHits++;
          }
        }
      } else {
        if (prob != null && prob >= threshold - 0.15 && prob < threshold) {
          nearMisses++;
        }
      }
    }

    const hitRate = hits / totalEvaluated;
    const fpRatio = hits > 0 ? (borderlineHits / hits) : 0;
    const scr = hits > 0 ? (strongHits / hits) : 0;

    let delta = 0.0;
    let reason = "Balanced / optimal routing";

    if (hitRate > 0.20 && fpRatio > 0.40) {
      // Case 1: Severe over-triggering with high borderline false-positive proxy
      delta = -Math.min(0.6, (hitRate - 0.15) * 1.2 + fpRatio * 0.4);
      reason = `Over-triggering (${Math.round(hitRate * 100)}%) with high borderline FP ratio (${Math.round(fpRatio * 100)}%)`;
    } else if (fpRatio > 0.50 && hits >= 3) {
      // Case 2: Borderline false-positive tendency
      delta = -Math.min(0.4, fpRatio * 0.4);
      reason = `Borderline trigger tendency (${Math.round(fpRatio * 100)}% near threshold)`;
    } else if (scr >= 0.70 && fpRatio < 0.20 && hits >= 2) {
      // Case 3: High-precision specialist boost
      delta = Math.min(0.4, 0.15 + scr * 0.2);
      reason = `High-precision specialist (${Math.round(scr * 100)}% strong triggers)`;
    } else if (nearMisses >= 2 && hitRate < 0.08) {
      // Case 4: Near-threshold suppressed skill boost
      delta = Math.min(0.3, 0.10 + (nearMisses / 10) * 0.2);
      reason = `Near-threshold suppressed (${nearMisses} near-misses)`;
    }

    const effectiveDelta = delta * sampleConfidence;
    const rawRecommended = curr + effectiveDelta;
    const recommended = Math.max(0.1, Math.min(2.0, Math.round(rawRecommended * 10) / 10));
    const roundedDelta = Math.round((recommended - curr) * 10) / 10;

    if (roundedDelta > 0) boosted++;
    else if (roundedDelta < 0) dampened++;
    else unchanged++;

    deltas[skill] = {
      current: curr,
      recommended: recommended,
      delta: roundedDelta,
      reason: roundedDelta === 0 && delta !== 0 ? "Adjustment rounded to 0 at current sample scale" : reason,
      metrics: {
        hits,
        hitRate: Math.round(hitRate * 100) / 100,
        fpRatio: Math.round(fpRatio * 100) / 100,
        scr: Math.round(scr * 100) / 100,
        nearMisses
      }
    };
    recommendedWeights[skill] = recommended;
  }

  return {
    totalEvaluated,
    skillWeights: recommendedWeights,
    deltas,
    recommendations: deltas,
    stats: { boosted, dampened, unchanged }
  };
}

// ponytail: short prompts (< 8 words or conversational triggers) lack domain keywords.
// Enrich with previous context so Jev router retains relevant skills across follow-ups.
export function enrichShortPrompt(prompt, prevContext = "") {
  if (!prompt || !prevContext) return prompt;
  const trimmed = prompt.trim();
  const words = trimmed.split(/\s+/);
  const isContinuation = words.length < 8 || /^(continue|next|more|fix|why|redo|go on|proceed|ok|yes|what else)/i.test(trimmed);
  if (isContinuation) {
    return `[Previous Topic: "${prevContext.trim()}"] Current Request: "${trimmed}"`;
  }
  return prompt;
}

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
 * Strip model-switching slash commands like `/model <name>` from prompt text
 * so TypeSafe Jev evaluates the actual coding task rather than model selection syntax.
 * @param {string} prompt
 * @returns {string}
 */
export function stripSlashCommands(prompt) {
  if (!prompt) return "";
  const trimmed = prompt.trim();
  // Strip /model <name> or /mode <name> or similar leading slash commands
  const cleaned = trimmed.replace(/^\/(?:model|mode|m)\s+[^\s]+\s+/i, "");
  return cleaned.trim() || trimmed;
}

/**
 * Extract raw prompt text from agy CLI arguments without stripping commands.
 * @param {string[]} args
 * @returns {string}
 */
export function extractRawUserPrompt(args) {
  let prompt = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // ponytail: support -p="value" or --prompt="value" syntax
    if (a.startsWith("-p=") || a.startsWith("--print=") || a.startsWith("-i=") || a.startsWith("--prompt=") || a.startsWith("--prompt-interactive=")) {
      prompt = a.slice(a.indexOf("=") + 1).replace(/^['"]|['"]$/g, "").trim();
      break;
    }
    if (["-p", "--print", "-i", "--prompt-interactive", "--prompt"].includes(a)) {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        prompt = args[i + 1];
        break;
      }
    }
  }
  if (!prompt) {
    prompt = args.filter((a) => !a.startsWith("-")).join(" ").trim();
  }
  return prompt;
}

/**
 * Extract the user prompt text from agy CLI arguments.
 * @param {string[]} args
 * @returns {string}
 */
export function extractUserPrompt(args) {
  return stripSlashCommands(extractRawUserPrompt(args));
}

/**
 * Detect model name chosen by the user from prompt or CLI arguments.
 * @param {string[]} [args=[]]
 * @param {string} [rawPrompt=""]
 * @returns {string}
 */
export function extractModel(args = [], rawPrompt = "") {
  // 1. Check prompt for /model <name> or /mode <name> or /m <name>
  const slashMatch = (rawPrompt || "").match(/^\/(?:model|mode|m)\s+([^\s]+)/i);
  if (slashMatch) return slashMatch[1].toLowerCase();

  // 2. Check agy args for --model <name> or -m <name> or --model=<name>
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--model=")) return a.slice(8).trim().toLowerCase();
    if (a === "--model" || a === "-m") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        return args[i + 1].trim().toLowerCase();
      }
    }
  }

  return "gemini-3-8-flash";
}

/**
 * Enforces System One effort into agyArgs.
 * System One strictly governs reasoning effort: strips any existing --effort flag
 * and sets the forced System One effort level.
 * @param {string[]} agyArgs
 * @param {"low" | "medium" | "high"} effort
 * @returns {string[]}
 */
export function injectEffortArg(agyArgs, effort) {
  const filtered = [];
  for (let i = 0; i < agyArgs.length; i++) {
    const a = agyArgs[i];
    if (a === "--effort") {
      i++; // skip manually passed effort value
      continue;
    }
    if (a.startsWith("--effort=")) continue;
    filtered.push(a);
  }
  return [...filtered, "--effort", effort];
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
          // ponytail: fallback to first markdown paragraph if YAML description is empty or a placeholder
          if (!desc || /^(one sentence|what this skill does|todo)/i.test(desc)) {
            const body = content.slice(fm[0].length).trim();
            const firstPara = body.split(/\r?\n\r?\n/)[0]?.replace(/[#*`_]/g, "").trim();
            if (firstPara) desc = firstPara;
          }
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
 * @param {{ threshold: number, timeoutMs: number, maxSkills: number, skillWeights?: Record<string, number> }} config
 * @param {string} [apiKey]
 * @param {string} [prevContext]
 * @returns {Promise<{ matchedSkills: string[], probabilities: Record<string, number>, latencyMs: number, error?: string }>}
 */
export async function queryJevRouter(userPrompt, skills, config, apiKey = process.env.TYPESAFE_API_KEY || "", prevContext = "") {
  const t0 = Date.now();
  const empty = (error) => ({ matchedSkills: [], probabilities: {}, latencyMs: Date.now() - t0, error });

  if (!apiKey)                      return empty("TYPESAFE_API_KEY not set");
  if (!skills.length || !userPrompt.trim()) return empty();

  // ponytail: if userPrompt is short, prepend previous topic context for multi-turn coherence
  const enrichedPrompt = enrichShortPrompt(userPrompt, prevContext);

  // ponytail: build one Noul question per skill. Jev runs them in parallel inside a single request.
  // Note: Question IDs are for code and not sent to the model, so we explicitly name the skill in instructions.
  const questions = {};
  for (const s of skills.slice(0, 200)) {
    questions[s.name] = {
      type: "noul",
      instructions: `Does the user's request benefit from or require the "${s.name}" skill?`,
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
      body: JSON.stringify({ state: enrichedPrompt, model: "jev-latest", questions }),
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
    const weights = config.skillWeights ?? {};

    for (const [id, ans] of Object.entries(data?.answers ?? {})) {
      const rawP = typeof ans?.noul === "number" && Number.isFinite(ans.noul) ? ans.noul : 0;
      const weightVal = weights[id];
      const weight = typeof weightVal === "number" && Number.isFinite(weightVal)
        ? Math.max(0.1, Math.min(weightVal, 2.0))
        : 1.0;
      const effectiveP = Math.min(Math.round(rawP * weight * 100) / 100, 1.0);
      probabilities[id] = effectiveP;
      if (effectiveP >= config.threshold) candidates.push({ name: id, prob: effectiveP });
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

// ─── Reasoning Effort Inference (TypeSafe Score Primitive) ───────────────────
/**
 * Map numerical Score position [0.0, 2.0] to Antigravity CLI effort level.
 * @param {number} score
 * @returns {"low" | "medium" | "high"}
 */
export function scoreToEffort(score) {
  if (score < 0.7) return "low";
  if (score < 1.5) return "medium";
  return "high";
}

/**
 * Infer reasoning effort using TypeSafe Jev Score question.
 * @param {string} prompt
 * @param {{ apiKey?: string, timeoutMs?: number, prevContext?: string }} [options]
 * @returns {Promise<{ effort: "low" | "medium" | "high", score: number, confidence: number, latencyMs: number, error?: string }>}
 */
export async function inferEffortLevel(prompt, options = {}) {
  const t0 = Date.now();
  const apiKey = options.apiKey ?? (process.env.TYPESAFE_API_KEY || "");
  const timeoutMs = options.timeoutMs ?? 1500;
  const prevContext = options.prevContext ?? "";

  const fallback = (error) => ({
    effort: "medium",
    score: 1.0,
    confidence: 0,
    latencyMs: Date.now() - t0,
    error,
  });

  if (!apiKey) return fallback("TYPESAFE_API_KEY not set");
  if (!prompt || !prompt.trim()) return fallback();

  const enriched = enrichShortPrompt(prompt, prevContext);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        state: enriched,
        model: "jev-latest",
        questions: {
          reasoning_effort: {
            type: "score",
            instructions: "How much reasoning effort, cognitive depth, and planning does this user request require?",
            criteria: [
              "Low effort: simple question, quick one-liner, lookup, minor typo fix, or straightforward command",
              "Medium effort: standard code implementation, multi-file edit, debugging an issue, or refactoring",
              "High effort: complex system architecture, deep multi-step planning, intricate algorithmic problem, or large-scale redesign",
            ],
          },
        },
      }),
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { effort: "medium", score: 1.0, confidence: 0, latencyMs, error: `HTTP ${res.status}: ${t}` };
    }

    const data = await res.json();
    const ans = data?.answers?.reasoning_effort;
    const score = typeof ans?.score === "number" && Number.isFinite(ans.score) ? ans.score : 1.0;
    const confidence = typeof ans?.confidence === "number" && Number.isFinite(ans.confidence) ? ans.confidence : 0;
    const effort = scoreToEffort(score);

    return { effort, score, confidence, latencyMs };
  } catch (err) {
    clearTimeout(timer);
    return fallback(err.name === "AbortError" ? `Timeout (>${timeoutMs}ms)` : err.message);
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
  const rawPrompt = extractRawUserPrompt(agyArgs);
  const prompt = extractUserPrompt(agyArgs);
  const detectedModel = extractModel(agyArgs, rawPrompt);
  let effectiveAgyArgs = [...agyArgs];

  let cleanupHook = null;

  if (prompt) {
    const skills = scanSkills();

    // ponytail: extract previous topic from telemetry for conversational follow-ups
    let prevPrompt = "";
    try {
      const telePath = path.join(os.homedir(), ".gemini", "antigravity-cli", "telemetry.json");
      if (fs.existsSync(telePath)) {
        const logs = JSON.parse(fs.readFileSync(telePath, "utf8"));
        if (logs.length > 0 && logs[0].prompt && logs[0].prompt !== prompt) {
          prevPrompt = logs[0].prompt;
        }
      }
    } catch { /* ignore */ }

    // ── Infer reasoning effort via TypeSafe Score primitive & auto-inject --effort ──
    const effortResult = await inferEffortLevel(prompt, { timeoutMs: cfg.timeoutMs, prevContext: prevPrompt });
    effectiveAgyArgs = injectEffortArg(effectiveAgyArgs, effortResult.effort);
    console.log(`\x1b[35m🎯 [Jev System 1] Reasoning effort: ${effortResult.effort.toUpperCase()} (score: ${effortResult.score.toFixed(2)}, conf: ${(effortResult.confidence * 100).toFixed(0)}%)\x1b[0m`);

    // ── Live Jev query on every run ──
    const result = await queryJevRouter(prompt, skills, cfg, undefined, prevPrompt);

    // Save telemetry log for dashboard
    try {
      const { saveTelemetry } = await import("./dashboard.mjs");
      const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
      saveTelemetry({
        id: `cli-${Date.now()}`,
        timestamp: Date.now(),
        prompt,
        model: detectedModel,
        effort: effortResult.effort,
        effortScore: effortResult.score,
        effortConfidence: effortResult.confidence,
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
    console.log(`\x1b[90m🛑 [dry-run] Effective args: ${effectiveAgyArgs.join(" ")}\x1b[0m`);
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

  const child = spawn(process.platform === "win32" ? "agy.exe" : "agy", effectiveAgyArgs, {
    stdio: "inherit",
    shell: false,
  });
  child.on("error", (err) => {
    if (cleanupHook) { cleanupHook(); cleanupHook = null; }
    console.error(`\x1b[31m❌ Failed to spawn Antigravity CLI (agy): ${err.message}\x1b[0m`);
    process.exit(1);
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
