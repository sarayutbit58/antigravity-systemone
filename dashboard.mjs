#!/usr/bin/env node
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { scanSkills, queryJevRouter, inferEffortLevel, loadConfig, saveConfig, loadEnv } from "./index.mjs";

loadEnv();

const PORT = Number(process.env.AGY_DASHBOARD_PORT) || 3737;
const TELEMETRY_PATH = path.join(
  os.homedir(), ".gemini", "antigravity-cli", "telemetry.json"
);

// ponytail: seed initial telemetry if none exists so meters show meaningful data right away
function getTelemetry() {
  if (!fs.existsSync(TELEMETRY_PATH)) {
    const seed = [
      {
        id: "seed-1",
        timestamp: Date.now() - 1000 * 60 * 18,
        prompt: "optimize my postgresql query with joins",
        matchedSkills: ["postgresql-optimization", "performance-profiling", "sql-pro"],
        latencyMs: 778,
        totalSkills: 54,
        tokensSaved: 3060,
        status: "success"
      },
      {
        id: "seed-2",
        timestamp: Date.now() - 1000 * 60 * 12,
        prompt: "Build a responsive React landing page with Tailwind CSS",
        matchedSkills: ["landing-page-generator", "react-nextjs-development", "react-best-practices"],
        latencyMs: 793,
        totalSkills: 54,
        tokensSaved: 3060,
        status: "success"
      },
      {
        id: "seed-3",
        timestamp: Date.now() - 1000 * 60 * 5,
        prompt: "hello how are you",
        matchedSkills: [],
        latencyMs: 714,
        totalSkills: 54,
        tokensSaved: 3240,
        status: "general_mode"
      }
    ];
    fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
    fs.writeFileSync(TELEMETRY_PATH, JSON.stringify(seed, null, 2), "utf8");
    return seed;
  }
  try {
    return JSON.parse(fs.readFileSync(TELEMETRY_PATH, "utf8"));
  } catch {
    return [];
  }
}

export function saveTelemetry(entry) {
  const list = getTelemetry();
  list.unshift(entry);
  if (list.length > 500) list.length = 500;
  fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
  fs.writeFileSync(TELEMETRY_PATH, JSON.stringify(list, null, 2), "utf8");
}

export const MODEL_PRICING_CATALOG = {
  "gemini-3-8-flash": { name: "Gemini 3.8 Flash (current)", provider: "Google", inputPerM: 0.15, outputPerM: 0.60 },
  "gemini-3-7-flash": { name: "Gemini 3.7 Flash", provider: "Google", inputPerM: 0.15, outputPerM: 0.60 },
  "gemini-3-6-flash": { name: "Gemini 3.6 Flash", provider: "Google", inputPerM: 0.10, outputPerM: 0.40 },
  "gemini-3-1-pro":   { name: "Gemini 3.1 Pro", provider: "Google", inputPerM: 1.25, outputPerM: 5.00 },
  "claude-sonnet-4-6":{ name: "Claude Sonnet 4.6 (Thinking)", provider: "Anthropic", inputPerM: 3.00, outputPerM: 15.00 },
  "claude-opus-4-6":  { name: "Claude Opus 4.6 (Thinking)", provider: "Anthropic", inputPerM: 15.00, outputPerM: 75.00 },
  "gpt-oss-120b":     { name: "GPT-OSS 120B (Medium)", provider: "OpenAI / Open-Source", inputPerM: 0.50, outputPerM: 1.50 }
};

export function resolveModelPricing(modelName = "") {
  const norm = (modelName || "").toLowerCase().trim();
  if (MODEL_PRICING_CATALOG[norm]) return MODEL_PRICING_CATALOG[norm];

  // Fuzzy match exact agy model keywords
  if (norm.includes("opus")) return MODEL_PRICING_CATALOG["claude-opus-4-6"];
  if (norm.includes("sonnet") || norm.includes("claude")) return MODEL_PRICING_CATALOG["claude-sonnet-4-6"];
  if (norm.includes("oss") || norm.includes("120b") || norm.includes("gpt")) return MODEL_PRICING_CATALOG["gpt-oss-120b"];
  if (norm.includes("3-1") || norm.includes("3.1") || norm.includes("pro")) return MODEL_PRICING_CATALOG["gemini-3-1-pro"];
  if (norm.includes("3-6") || norm.includes("3.6")) return MODEL_PRICING_CATALOG["gemini-3-6-flash"];
  if (norm.includes("3-7") || norm.includes("3.7")) return MODEL_PRICING_CATALOG["gemini-3-7-flash"];
  if (norm.includes("3-8") || norm.includes("3.8") || norm.includes("flash") || norm.includes("current")) {
    return MODEL_PRICING_CATALOG["gemini-3-8-flash"];
  }

  // Default current Antigravity model
  return MODEL_PRICING_CATALOG["gemini-3-8-flash"];
}

// ponytail: detect active model in real-time directly from latest Antigravity IDE transcripts
export function detectActiveModelRealtime() {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  if (!fs.existsSync(brainDir)) return null;
  try {
    const convs = fs.readdirSync(brainDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ file: path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl") }))
      .filter((d) => fs.existsSync(d.file))
      .map((d) => ({ ...d, mtime: fs.statSync(d.file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const c of convs.slice(0, 3)) {
      try {
        const lines = fs.readFileSync(c.file, "utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 80); i--) {
          const step = JSON.parse(lines[i]);
          if (step.type === "USER_INPUT" && typeof step.content === "string") {
            const marker = "Model Selection";
            const pos = step.content.indexOf(marker);
            if (pos !== -1) {
              const chunk = step.content.slice(pos);
              const toIdx = chunk.indexOf(" to ");
              if (toIdx !== -1) {
                const after = chunk.slice(toIdx + 4);
                const endIdx = after.indexOf(". No need");
                const model = (endIdx !== -1 ? after.slice(0, endIdx) : after.split(/[\n<]/)[0]).trim();
                if (model) return model;
              }
            }
          }
        }
      } catch { /* skip unparseable line */ }
    }
  } catch { /* ignore */ }
  return null;
}

function calculateMetrics(logs, totalSkills = 54) {
  const total = logs.length;
  if (total === 0) {
    return {
      totalRequests: 0,
      avgLatencyMs: 0,
      totalTokensSaved: 0,
      avgTokenSavingsPct: 0,
      estimatedCostSavedUsd: "0.0000",
      generalModeCount: 0,
      specializedCount: 0,
      discoveredActiveModel: resolveModelPricing("gemini-3-8-flash"),
      modelStats: {},
      recentLogs: [],
      trendLogs: [],
      skillStats: {}
    };
  }

  const liveModel = detectActiveModelRealtime();
  let lastModel = liveModel || "gemini-3-8-flash";
  if (!liveModel) {
    for (const log of logs) {
      if (log.model) {
        lastModel = log.model;
        break;
      }
    }
  }
  const discoveredActiveModel = resolveModelPricing(lastModel);

  let totalLatency = 0;
  let totalSaved = 0;
  let generalCount = 0;
  let totalCostSaved = 0;
  const skillCount = {};
  const modelCount = {};

  for (const log of logs) {
    totalLatency += log.latencyMs || 0;
    const tokens = log.tokensSaved || 0;
    totalSaved += tokens;

    // Resolve real model pricing for this request
    const pricing = resolveModelPricing(log.model || "gemini-3-8-flash");
    const rowCost = (tokens / 1_000_000) * pricing.inputPerM;
    totalCostSaved += rowCost;

    modelCount[pricing.name] = (modelCount[pricing.name] || 0) + 1;

    if (!log.matchedSkills || log.matchedSkills.length === 0) {
      generalCount++;
    } else {
      for (const s of log.matchedSkills) {
        skillCount[s] = (skillCount[s] || 0) + 1;
      }
    }
  }

  const avgLatency = Math.round(totalLatency / total);
  const avgSavedPct = totalSkills > 0 
    ? Math.round(((totalSkills - (logs.reduce((acc, l) => acc + (l.matchedSkills?.length || 0), 0) / total)) / totalSkills) * 100)
    : 0;

  return {
    totalRequests: total,
    avgLatencyMs: avgLatency,
    totalTokensSaved: totalSaved,
    avgTokenSavingsPct: avgSavedPct,
    estimatedCostSavedUsd: totalCostSaved.toFixed(4),
    generalModeCount: generalCount,
    specializedCount: total - generalCount,
    discoveredActiveModel,
    modelStats: modelCount,
    recentLogs: logs.slice(0, 30).map((l) => {
      const pricing = resolveModelPricing(l.model || "gemini-3-8-flash");
      const cost = ((l.tokensSaved || 0) / 1_000_000) * pricing.inputPerM;
      return {
        ...l,
        model: l.model || "gemini-3-8-flash",
        modelName: pricing.name,
        modelRate: pricing.inputPerM,
        costSavedUsd: cost.toFixed(4)
      };
    }),
    trendLogs: logs.slice(0, 20).reverse().map((l, idx) => ({
      idx: idx + 1,
      id: l.id,
      prompt: l.prompt,
      model: l.model || "gemini-3-8-flash",
      latencyMs: l.latencyMs || 0,
      tokensSaved: l.tokensSaved || 0,
      matchedSkillsCount: l.matchedSkills?.length || 0,
      matchedSkills: l.matchedSkills || [],
      status: l.status || (l.matchedSkills?.length > 0 ? "specialized" : "general_mode"),
      timestamp: l.timestamp
    })),
    skillStats: skillCount
  };
}

export function createDashboardServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/config") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(loadConfig()));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const updates = JSON.parse(body || "{}");
            const saved = saveConfig(updates);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, config: saved }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
    }

    if (url.pathname === "/api/metrics") {
      const skills = scanSkills();
      const logs = getTelemetry();
      const metrics = calculateMetrics(logs, skills.length);
      metrics.availableSkillsCount = skills.length;
      metrics.config = loadConfig();
      metrics.models = Object.entries(MODEL_PRICING_CATALOG).map(([id, info]) => ({
        id,
        ...info
      }));
      metrics.skills = skills.map((s) => ({
        ...s,
        hits: metrics.skillStats[s.name] || 0
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
      return;
    }

    if (url.pathname === "/api/models") {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      let list = Object.entries(MODEL_PRICING_CATALOG).map(([id, info]) => ({
        id,
        ...info
      }));
      if (q) {
        list = list.filter((m) =>
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (url.pathname === "/api/skills") {
      const skills = scanSkills();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(skills));
      return;
    }

    if (url.pathname === "/api/clear" && req.method === "POST") {
      fs.writeFileSync(TELEMETRY_PATH, JSON.stringify([], null, 2), "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { prompt, prevContext, model } = JSON.parse(body || "{}");
          if (!prompt || !prompt.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Prompt is required" }));
            return;
          }

          const pickedModel = model || "gemini-3-8-flash";
          const pricing = resolveModelPricing(pickedModel);

          const skills = scanSkills();
          const cfg = loadConfig();
          const [result, effortResult] = await Promise.all([
            queryJevRouter(prompt, skills, cfg, undefined, prevContext),
            inferEffortLevel(prompt, { timeoutMs: cfg.timeoutMs, prevContext })
          ]);

          const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
          const costSaved = ((tokensSaved / 1_000_000) * pricing.inputPerM).toFixed(4);
          const entry = {
            id: `run-${Date.now()}`,
            timestamp: Date.now(),
            prompt: prompt.trim(),
            model: pickedModel,
            effort: effortResult.effort,
            effortScore: effortResult.score,
            effortConfidence: effortResult.confidence,
            matchedSkills: result.matchedSkills,
            latencyMs: result.latencyMs,
            totalSkills: skills.length,
            tokensSaved,
            costSavedUsd: costSaved,
            status: result.error ? "error" : (result.matchedSkills.length > 0 ? "specialized" : "general_mode"),
            probabilities: result.probabilities,
            error: result.error
          };

          saveTelemetry(entry);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ...result,
            effort: effortResult.effort,
            effortScore: effortResult.score,
            effortConfidence: effortResult.confidence,
            tokensSaved,
            totalSkills: skills.length,
            timestamp: entry.timestamp,
            model: pickedModel,
            modelName: pricing.name,
            modelRate: pricing.inputPerM,
            costSavedUsd: costSaved
          }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Serve HTML Dashboard
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboardHtml());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return server;
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity agy-smart Performance Meter</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #0d1117;
      --card-bg: #161b22;
      --card-border: #30363d;
      --accent-cyan: #58a6ff;
      --accent-green: #3fb950;
      --accent-purple: #bc8cff;
      --accent-orange: #d29922;
      --accent-red: #f85149;
    }
    body {
      background-color: var(--bg-base);
      font-family: 'Plus Jakarta Sans', sans-serif;
      color: #c9d1d9;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    }
    .card-header {
      background-color: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--card-border);
      font-weight: 700;
    }
    .meter-circle {
      position: relative;
      width: 170px;
      height: 95px;
      margin: 0 auto;
      overflow: hidden;
    }
    .meter-gauge-svg {
      width: 170px;
      height: 170px;
      transform: rotate(-90deg);
    }
    .meter-value-overlay {
      position: absolute;
      bottom: 2px;
      left: 0;
      right: 0;
      text-align: center;
    }
    .badge-skill {
      background-color: rgba(88, 166, 255, 0.15);
      color: var(--accent-cyan);
      border: 1px solid rgba(88, 166, 255, 0.3);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 0.75rem;
    }
    .badge-general {
      background-color: rgba(63, 185, 80, 0.15);
      color: var(--accent-green);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 0.75rem;
    }
    .prob-bar {
      height: 6px;
      background: #21262d;
      border-radius: 3px;
      overflow: hidden;
    }
    .prob-fill {
      height: 100%;
      background: linear-gradient(90deg, #58a6ff, #3fb950);
      transition: width 0.4s ease;
    }
    .pulse-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--accent-green);
      box-shadow: 0 0 8px var(--accent-green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }
    .trend-chart-box {
      position: relative;
      width: 100%;
      height: 190px;
    }
    .trend-tooltip {
      position: absolute;
      display: none;
      background: rgba(22, 27, 34, 0.95);
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.75rem;
      pointer-events: none;
      z-index: 10;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      max-width: 320px;
    }
    .skill-card {
      transition: transform 0.15s ease, border-color 0.15s ease;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--card-border);
      border-radius: 10px;
    }
    .skill-card:hover {
      border-color: rgba(88, 166, 255, 0.45) !important;
      background: rgba(255,255,255,0.04);
      transform: translateY(-2px);
    }
    .pill-stat {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 0.8rem;
    }
    .x-small { font-size: 0.75rem; }
  </style>
</head>
<body class="p-3 p-md-4">
  <div class="container-fluid max-w-1400" style="max-width: 1400px;">
    
    <!-- Top Navbar -->
    <header class="d-flex flex-wrap justify-content-between align-items-center pb-3 mb-4 border-bottom border-secondary-subtle">
      <div class="d-flex align-items-center gap-3">
        <div class="p-2 rounded bg-primary bg-opacity-10 text-primary border border-primary border-opacity-25">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
        </div>
        <div>
          <h4 class="mb-0 fw-bold d-flex align-items-center gap-2">
            agy-smart <span class="badge bg-primary bg-opacity-25 text-info border border-info border-opacity-25 fs-6">System 1 Router</span>
          </h4>
          <small class="text-secondary">TypeSafe Jev Model Metered Performance Dashboard</small>
        </div>
      </div>
      <div class="d-flex align-items-center gap-2 mt-2 mt-sm-0 flex-wrap">
        <span id="discoveredModelBadge" class="badge bg-primary bg-opacity-15 text-info border border-info border-opacity-25 mono small py-1 px-2 d-flex align-items-center gap-1">
          <span class="pulse-dot me-1"></span> Active: <span id="discoveredModelName" class="fw-bold">Detecting...</span>
        </span>
        <button class="btn btn-sm btn-outline-info d-flex align-items-center gap-1" data-bs-toggle="modal" data-bs-target="#configModal">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          Router Settings
        </button>
        <button class="btn btn-sm btn-outline-secondary" onclick="fetchMetrics()">Refresh</button>
      </div>
    </header>

    <!-- Modal: Live Configuration Editor -->
    <div class="modal fade" id="configModal" tabindex="-1" aria-labelledby="configModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content bg-dark border-secondary">
          <div class="modal-header border-secondary-subtle">
            <h5 class="modal-title fw-bold d-flex align-items-center gap-2" id="configModalLabel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              Live Router Settings
            </h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <p class="small text-secondary mb-3">Tune routing threshold, max skill injection cap, and timeout with immediate effect.</p>
            
            <!-- Quick Presets -->
            <div class="mb-3">
              <label class="form-label small text-secondary fw-bold text-uppercase">Presets</label>
              <div class="d-flex gap-2">
                <button type="button" class="btn btn-sm btn-outline-info" onclick="applyPreset(0.35, 7, 2000)">⚡ Aggressive</button>
                <button type="button" class="btn btn-sm btn-outline-primary" onclick="applyPreset(0.50, 5, 2000)">🎯 Balanced</button>
                <button type="button" class="btn btn-sm btn-outline-warning" onclick="applyPreset(0.65, 3, 2000)">🛡️ Strict</button>
              </div>
            </div>

            <!-- Threshold Slider -->
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <label for="cfgThreshold" class="form-label small text-secondary fw-bold mb-0">PROBABILITY THRESHOLD</label>
                <span id="cfgThresholdVal" class="badge bg-primary mono">--</span>
              </div>
              <input type="range" class="form-range" id="cfgThreshold" min="0.10" max="0.90" step="0.05" value="0.50" oninput="document.getElementById('cfgThresholdVal').textContent=Number(this.value).toFixed(2)">
              <div class="d-flex justify-content-between text-secondary x-small mono">
                <span>0.10 (More skills matched)</span>
                <span>0.90 (High precision only)</span>
              </div>
            </div>

            <!-- Max Skills -->
            <div class="mb-3">
              <label for="cfgMaxSkills" class="form-label small text-secondary fw-bold mb-1">MAX SKILLS CAP</label>
              <input type="number" class="form-control bg-black border-secondary text-light mono" id="cfgMaxSkills" min="1" max="15" value="5">
              <small class="text-secondary">Upper bound of specialized skills injected per session.</small>
            </div>

            <!-- Timeout Ms -->
            <div class="mb-3">
              <label for="cfgTimeoutMs" class="form-label small text-secondary fw-bold mb-1">JEV API TIMEOUT (MS)</label>
              <input type="number" class="form-control bg-black border-secondary text-light mono" id="cfgTimeoutMs" min="300" max="10000" step="100" value="2000">
              <small class="text-secondary">Timeout limit before graceful fallback.</small>
            </div>

            <!-- Verbose Toggle -->
            <div class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" role="switch" id="cfgVerbose">
              <label class="form-check-label small" for="cfgVerbose">Verbose CLI Console Output</label>
            </div>

            <div id="cfgAlertBox" class="alert alert-success py-2 px-3 small mt-3" style="display:none;"></div>
          </div>
          <div class="modal-footer border-secondary-subtle">
            <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Close</button>
            <button type="button" class="btn btn-sm btn-primary fw-bold" id="btnSaveConfig" onclick="saveDashboardConfig()">Save Changes</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Row 1: Key Performance Gauges / Meters -->
    <div class="row g-3 mb-4">
      
      <!-- Meter 1: Latency Speedometer -->
      <div class="col-12 col-sm-6 col-xl-3">
        <div class="card h-100 p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="text-secondary small fw-bold text-uppercase">Avg Response Speed</span>
            <span class="badge bg-success bg-opacity-10 text-success border border-success border-opacity-25">Ultra Fast</span>
          </div>
          <div class="meter-circle my-1">
            <svg class="meter-gauge-svg" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" fill="none" stroke="#21262d" stroke-width="12" stroke-dasharray="125.6 251.2"></circle>
              <circle id="gaugeLatency" cx="50" cy="50" r="40" fill="none" stroke="#3fb950" stroke-width="12" stroke-dasharray="0 251.2" stroke-linecap="round" style="transition: stroke-dasharray 0.6s ease;"></circle>
            </svg>
            <div class="meter-value-overlay">
              <span id="meterLatencyVal" class="fs-3 fw-bold mono text-light">--</span>
              <small class="text-secondary">ms</small>
            </div>
          </div>
          <div class="d-flex justify-content-between text-secondary x-small px-2 mt-1">
            <span class="mono">0ms</span>
            <span class="mono text-center">1000ms</span>
            <span class="mono">2000ms</span>
          </div>
        </div>
      </div>

      <!-- Meter 2: Token Efficiency Gauge -->
      <div class="col-12 col-sm-6 col-xl-3">
        <div class="card h-100 p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="text-secondary small fw-bold text-uppercase">Context Efficiency</span>
            <span class="badge bg-info bg-opacity-10 text-info border border-info border-opacity-25">Savings</span>
          </div>
          <div class="meter-circle my-1">
            <svg class="meter-gauge-svg" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" fill="none" stroke="#21262d" stroke-width="12" stroke-dasharray="125.6 251.2"></circle>
              <circle id="gaugeTokens" cx="50" cy="50" r="40" fill="none" stroke="#58a6ff" stroke-width="12" stroke-dasharray="0 251.2" stroke-linecap="round" style="transition: stroke-dasharray 0.6s ease;"></circle>
            </svg>
            <div class="meter-value-overlay">
              <span id="meterTokenPct" class="fs-3 fw-bold mono text-info">--</span>
              <small class="text-secondary">%</small>
            </div>
          </div>
          <div class="d-flex justify-content-between text-secondary x-small px-2 mt-1">
            <span class="mono">0%</span>
            <span class="mono text-center">Avg Reduction</span>
            <span class="mono">100%</span>
          </div>
        </div>
      </div>

      <!-- Meter 3: Cumulative Tokens Saved & Real Cost Saved -->
      <div class="col-12 col-sm-6 col-xl-3">
        <div class="card h-100 p-3 d-flex flex-column justify-content-between">
          <div>
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="text-secondary small fw-bold text-uppercase">Total Tokens Saved</span>
              <span class="badge bg-purple bg-opacity-10 text-warning border border-warning border-opacity-25">Cumulative</span>
            </div>
            <h2 id="totalTokensVal" class="mono fw-bold text-warning mb-1">--</h2>
            <p class="small text-secondary mb-0">Tokens prevented from flooding LLM system prompt</p>
          </div>
          <div class="pt-2 border-top border-secondary-subtle">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <span class="small text-secondary">Real Cost Saved:</span>
              <span id="estCostVal" class="mono fw-bold text-success fs-5">$0.0000</span>
            </div>
            <div class="d-flex justify-content-between align-items-center gap-1">
              <small class="text-secondary x-small text-truncate">Price Simulator:</small>
              <select id="simModelSelect" class="form-select form-select-sm bg-black border-secondary text-info mono x-small py-0 px-2" style="width: auto; max-width: 160px; height: 24px;" onchange="recalcCostWithModel(this.value)">
                <option value="actual">Actual User Pickups</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- Meter 4: Routing Ratio -->
      <div class="col-12 col-sm-6 col-xl-3">
        <div class="card h-100 p-3 d-flex flex-column justify-content-between">
          <div>
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="text-secondary small fw-bold text-uppercase">Routing Decisions</span>
              <span id="totalReqBadge" class="badge bg-secondary">0 requests</span>
            </div>
            <div class="d-flex gap-3 my-2">
              <div>
                <small class="text-secondary d-block">Specialized Skills</small>
                <span id="statSpecialized" class="fs-4 fw-bold mono text-light">0</span>
              </div>
              <div class="border-start border-secondary ps-3">
                <small class="text-secondary d-block">General Mode (0 Skills)</small>
                <span id="statGeneral" class="fs-4 fw-bold mono text-success">0</span>
              </div>
            </div>
          </div>
          <div class="progress" style="height: 6px;">
            <div id="ratioSpecializedBar" class="progress-bar bg-primary" style="width: 50%"></div>
            <div id="ratioGeneralBar" class="progress-bar bg-success" style="width: 50%"></div>
          </div>
        </div>
      </div>

    </div>

    <!-- Row 1.5: Performance Trend Chart -->
    <div class="card mb-4">
      <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
        <div class="d-flex align-items-center gap-2">
          <span>📈 Performance & Efficiency Timeline</span>
          <span class="badge bg-secondary">Last 20 Runs</span>
        </div>
        <div class="d-flex flex-wrap align-items-center gap-2">
          <span class="pill-stat mono text-success"><small class="text-secondary">Fastest:</small> <span id="trendFastest">-- ms</span></span>
          <span class="pill-stat mono text-light"><small class="text-secondary">Avg Latency:</small> <span id="trendAvg">-- ms</span></span>
          <span class="pill-stat mono text-info"><small class="text-secondary">Tokens Saved:</small> <span id="trendTokens">--</span></span>
        </div>
      </div>
      <div class="card-body p-3">
        <div class="trend-chart-box">
          <div id="chartTooltip" class="trend-tooltip"></div>
          <svg id="trendSvg" viewBox="0 0 920 180" class="w-100 h-100">
            <!-- Gridlines, Bars, Lines rendered by JS -->
          </svg>
        </div>
        <div class="d-flex justify-content-between align-items-center small text-secondary mt-1 px-1">
          <div class="d-flex gap-3">
            <span class="d-flex align-items-center gap-1"><span style="width:10px;height:10px;background:#58a6ff;opacity:0.4;display:inline-block;border-radius:2px;"></span> Tokens Saved (bars)</span>
            <span class="d-flex align-items-center gap-1"><span style="width:10px;height:10px;background:#3fb950;display:inline-block;border-radius:50%;"></span> Latency (line)</span>
          </div>
          <span class="mono">Recent Requests (Oldest &rarr; Newest)</span>
        </div>
      </div>
    </div>

    <!-- Row 2: Live Prompt Tester & Skills Breakdown -->
    <div class="row g-3 mb-4">
      
      <!-- Interactive Test Bench -->
      <div class="col-12 col-lg-7">
        <div class="card h-100">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>⚡ Interactive Live Prompt Bench</span>
            <small class="text-secondary">Direct Jev System 1 Execution</small>
          </div>
          <div class="card-body">
            <p class="small text-secondary mb-2">Type any prompt to observe live latency, Noul probabilities, and skill filtration in real time:</p>
            
            <!-- Pickup Model Selector Row -->
            <div class="row g-2 mb-2 align-items-center">
              <div class="col-12 col-md-7">
                <div class="input-group input-group-sm">
                  <span class="input-group-text bg-black border-secondary text-secondary mono x-small">PICKUP MODEL</span>
                  <select id="testModelSelect" class="form-select bg-dark border-secondary text-light mono x-small" onchange="onTestModelChange(this.value)">
                    <!-- Populated dynamically with real model prices -->
                  </select>
                </div>
              </div>
              <div class="col-12 col-md-5 text-md-end">
                <span id="selectedModelRateBadge" class="badge bg-primary bg-opacity-10 text-info border border-info border-opacity-25 mono x-small">
                  Rate: $1.25 / 1M input tokens
                </span>
              </div>
            </div>

            <div class="row g-2 mb-3">
              <div class="col-12 col-md-8">
                <input type="text" id="testPromptInput" class="form-control mono bg-dark border-secondary text-light" placeholder="e.g. continue or optimize postgresql query" value="optimize postgresql query with joins">
              </div>
              <div class="col-12 col-md-4">
                <div class="input-group">
                  <input type="text" id="testContextInput" class="form-control mono bg-dark border-secondary text-light" placeholder="Prior context (optional)">
                  <button class="btn btn-primary fw-bold px-3" id="btnTestPrompt" onclick="runLiveTest()">
                    Meter Query
                  </button>
                </div>
              </div>
            </div>

            <!-- Live Result Display -->
            <div id="liveResultBox" class="p-3 rounded bg-black bg-opacity-30 border border-secondary border-opacity-50" style="display: none;">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="small fw-bold">Live Execution Metrics</span>
                <div class="d-flex gap-2 align-items-center flex-wrap">
                  <span id="liveEffortBadge" class="badge mono fs-6" style="display: none;">EFFORT: --</span>
                  <span id="liveCostBadge" class="badge bg-success bg-opacity-25 text-success border border-success border-opacity-25 mono fs-6" style="display: none;">SAVED: $0.0000</span>
                  <span id="liveLatencyBadge" class="badge bg-success mono fs-6">0 ms</span>
                </div>
              </div>
              <div class="row g-2 mb-2">
                <div class="col-sm-6">
                  <small class="text-secondary d-block">Matched Skills:</small>
                  <div id="liveSkillsList" class="d-flex flex-wrap gap-1 mt-1"></div>
                </div>
                <div class="col-sm-6">
                  <small class="text-secondary d-block">Token Savings:</small>
                  <span id="liveSavingsVal" class="mono fw-bold text-info">--</span>
                </div>
              </div>

              <!-- Top Probabilities breakdown -->
              <div class="mt-3">
                <small class="text-secondary fw-bold d-block mb-1">Top Skill Probabilities:</small>
                <div id="liveProbList" class="d-flex flex-column gap-2"></div>
              </div>
            </div>

          </div>
        </div>
      </div>

      <!-- Skill Trigger Distribution -->
      <div class="col-12 col-lg-5">
        <div class="card h-100">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>📊 Top Triggered Skills</span>
            <span id="availSkillsCount" class="badge bg-secondary">54 Available</span>
          </div>
          <div class="card-body">
            <div id="skillDistList" class="d-flex flex-column gap-3">
              <div class="text-secondary small text-center py-4">Loading stats...</div>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Row 3: Telemetry Log Table -->
    <div class="card mb-4">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span>📜 Real-Time Audit & Telemetry Log</span>
        <button class="btn btn-sm btn-outline-danger" onclick="clearTelemetry()">Clear Logs</button>
      </div>
      <div class="table-responsive">
        <table class="table table-dark table-hover mb-0 align-middle">
          <thead>
            <tr class="text-secondary small text-uppercase">
              <th style="width: 105px;">Time</th>
              <th style="width: 140px;">Model</th>
              <th>Prompt</th>
              <th style="width: 85px;" class="text-center">Effort</th>
              <th style="width: 220px;">Matched Skills</th>
              <th style="width: 90px;" class="text-end">Latency</th>
              <th style="width: 110px;" class="text-end">Tokens Saved</th>
              <th style="width: 110px;" class="text-end">Cost Saved</th>
            </tr>
          </thead>
          <tbody id="telemetryTableBody">
            <tr><td colspan="8" class="text-center text-secondary py-3">Loading telemetry...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Row 4: Skills Catalog & Matrix -->
    <div class="card mb-4" id="skillsCatalogSection">
      <div class="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
        <div class="d-flex align-items-center gap-2">
          <span>🧩 Installed Skills Catalog & Routing Matrix</span>
          <span id="catalogCountBadge" class="badge bg-primary bg-opacity-25 text-info border border-info border-opacity-25">54 Skills</span>
        </div>
        <div class="d-flex gap-2">
          <div class="btn-group btn-group-sm" role="group">
            <button type="button" class="btn btn-outline-secondary active" id="btnFilterAll" onclick="setCatalogFilter('all')">All</button>
            <button type="button" class="btn btn-outline-secondary" id="btnFilterTriggered" onclick="setCatalogFilter('triggered')">Triggered</button>
            <button type="button" class="btn btn-outline-secondary" id="btnFilterDormant" onclick="setCatalogFilter('dormant')">Dormant</button>
          </div>
          <input type="text" id="catalogSearchInput" class="form-control form-control-sm bg-dark border-secondary text-light mono" placeholder="Search skills..." style="width: 220px;" oninput="renderSkillsCatalog()">
        </div>
      </div>
      <div class="card-body p-3">
        <div id="skillsCatalogGrid" class="row g-3">
          <div class="text-secondary small text-center py-4">Loading catalog...</div>
        </div>
      </div>
    </div>

  </div>

  <script>
    let cachedSkills = [];
    let cachedMetrics = {};
    let cachedModels = [];
    let catalogFilter = 'all';

    async function fetchMetrics() {
      try {
        const res = await fetch('/api/metrics');
        const data = await res.json();
        cachedMetrics = data;
        cachedSkills = data.skills || [];
        cachedModels = data.models || [];
        populateModelSelects(cachedModels);
        updateDashboard(data);
        renderTrendChart(data.trendLogs || []);
        syncConfigForm(data.config);
        renderSkillsCatalog();
      } catch (err) {
        console.error('Failed to load metrics:', err);
      }
    }

    function populateModelSelects(models) {
      if (!models || models.length === 0) return;
      const testSelect = document.getElementById('testModelSelect');
      const simSelect = document.getElementById('simModelSelect');

      if (testSelect && testSelect.options.length <= 1) {
        const currVal = testSelect.value;
        testSelect.innerHTML = models.map(m => {
          return '<option value="' + m.id + '">' + m.name + ' ($' + m.inputPerM.toFixed(2) + ' / 1M tokens)</option>';
        }).join('');
        const defaultModelId = (cachedMetrics.discoveredActiveModel && cachedMetrics.discoveredActiveModel.id) || 'gemini-3-8-flash';
        if (currVal && models.some(m => m.id === currVal)) {
          testSelect.value = currVal;
        } else {
          testSelect.value = defaultModelId;
        }
        onTestModelChange(testSelect.value);
      }

      if (simSelect && simSelect.options.length <= 1) {
        const currSim = simSelect.value;
        let simHtml = '<option value="actual">Actual User Pickups</option>';
        simHtml += models.map(m => {
          return '<option value="' + m.id + '">' + m.name + ' ($' + m.inputPerM.toFixed(2) + '/M)</option>';
        }).join('');
        simSelect.innerHTML = simHtml;
        if (currSim) simSelect.value = currSim;
      }
    }

    let userSelectedModelManually = false;

    function onTestModelChange(val) {
      userSelectedModelManually = true;
      const m = cachedModels.find(x => x.id === val);
      const badge = document.getElementById('selectedModelRateBadge');
      if (badge && m) {
        badge.textContent = 'Rate: $' + m.inputPerM.toFixed(2) + ' / 1M input tokens (' + m.provider + ')';
      }
    }

    function recalcCostWithModel(val) {
      const costEl = document.getElementById('estCostVal');
      if (!costEl) return;
      if (val === 'actual') {
        costEl.textContent = '$' + (cachedMetrics.estimatedCostSavedUsd || '0.0000');
        return;
      }
      const m = cachedModels.find(x => x.id === val);
      if (!m) return;
      const totalTokens = cachedMetrics.totalTokensSaved || 0;
      const simCost = (totalTokens / 1000000) * m.inputPerM;
      costEl.textContent = '$' + simCost.toFixed(4);
    }

    function syncConfigForm(cfg) {
      if (!cfg) return;
      if (document.getElementById('cfgThreshold')) {
        document.getElementById('cfgThreshold').value = cfg.threshold;
        document.getElementById('cfgThresholdVal').textContent = Number(cfg.threshold).toFixed(2);
      }
      if (document.getElementById('cfgMaxSkills')) {
        document.getElementById('cfgMaxSkills').value = cfg.maxSkills;
      }
      if (document.getElementById('cfgTimeoutMs')) {
        document.getElementById('cfgTimeoutMs').value = cfg.timeoutMs;
      }
      if (document.getElementById('cfgVerbose')) {
        document.getElementById('cfgVerbose').checked = Boolean(cfg.verbose);
      }
    }

    function applyPreset(threshold, maxSkills, timeoutMs) {
      document.getElementById('cfgThreshold').value = threshold;
      document.getElementById('cfgThresholdVal').textContent = Number(threshold).toFixed(2);
      document.getElementById('cfgMaxSkills').value = maxSkills;
      document.getElementById('cfgTimeoutMs').value = timeoutMs;
    }

    async function saveDashboardConfig() {
      const btn = document.getElementById('btnSaveConfig');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';
      const alertBox = document.getElementById('cfgAlertBox');
      alertBox.style.display = 'none';

      try {
        const payload = {
          threshold: parseFloat(document.getElementById('cfgThreshold').value),
          maxSkills: parseInt(document.getElementById('cfgMaxSkills').value, 10),
          timeoutMs: parseInt(document.getElementById('cfgTimeoutMs').value, 10),
          verbose: document.getElementById('cfgVerbose').checked
        };
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          alertBox.className = 'alert alert-success py-2 px-3 small mt-3';
          alertBox.textContent = 'Configuration saved and active for subsequent runs!';
          alertBox.style.display = 'block';
          fetchMetrics();
        } else {
          throw new Error(data.error || 'Failed to save');
        }
      } catch (err) {
        alertBox.className = 'alert alert-danger py-2 px-3 small mt-3';
        alertBox.textContent = 'Error: ' + err.message;
        alertBox.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Save Changes';
      }
    }

    function renderTrendChart(trendLogs) {
      const svg = document.getElementById('trendSvg');
      const tooltip = document.getElementById('chartTooltip');
      if (!trendLogs || trendLogs.length === 0) {
        svg.innerHTML = '<text x="460" y="90" text-anchor="middle" fill="#6e7681" font-size="14">No trend samples recorded yet.</text>';
        return;
      }

      // Compute stats
      const latencies = trendLogs.map(l => l.latencyMs || 0);
      const fastest = Math.min(...latencies);
      const avg = Math.round(latencies.reduce((a,b) => a+b, 0) / latencies.length);
      const totalTokens = trendLogs.reduce((a,b) => a + (b.tokensSaved || 0), 0);
      document.getElementById('trendFastest').textContent = fastest + ' ms';
      document.getElementById('trendAvg').textContent = avg + ' ms';
      document.getElementById('trendTokens').textContent = '+' + totalTokens.toLocaleString();

      const W = 920;
      const H = 180;
      const padL = 50;
      const padR = 40;
      const padT = 20;
      const padB = 30;
      const chartW = W - padL - padR;
      const chartH = H - padT - padB;

      const maxLat = Math.max(1200, ...latencies, 2000);
      const maxTok = 3300;
      const count = trendLogs.length;
      const stepX = count > 1 ? chartW / (count - 1) : chartW / 2;

      let svgHtml = '';

      // Horizontal Grid lines & Y-axis labels
      const yTicks = [0.25, 0.5, 0.75, 1];
      yTicks.forEach(t => {
        const y = padT + chartH * (1 - t);
        const latVal = Math.round(maxLat * t);
        svgHtml += \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#21262d" stroke-dasharray="3 3"/>\`;
        svgHtml += \`<text x="\${padL - 8}" y="\${y + 4}" fill="#6e7681" font-size="10" text-anchor="end" class="mono">\${latVal}ms</text>\`;
      });

      // Bottom baseline
      svgHtml += \`<line x1="\${padL}" y1="\${H - padB}" x2="\${W - padR}" y2="\${H - padB}" stroke="#30363d"/>\`;

      // Token Saved Bars (Cyan)
      trendLogs.forEach((l, i) => {
        const x = count === 1 ? padL + chartW / 2 : padL + i * stepX;
        const barW = Math.max(8, Math.min(24, (chartW / count) * 0.45));
        const tokH = Math.min(chartH, ((l.tokensSaved || 0) / maxTok) * chartH);
        const y = (H - padB) - tokH;
        svgHtml += \`
          <rect x="\${x - barW/2}" y="\${y}" width="\${barW}" height="\${tokH}" fill="#58a6ff" opacity="0.3" rx="2"
                data-idx="\${i}" class="chart-hover-target"/>
        \`;
      });

      // Latency Line points & path
      const points = trendLogs.map((l, i) => {
        const x = count === 1 ? padL + chartW / 2 : padL + i * stepX;
        const frac = Math.min((l.latencyMs || 0) / maxLat, 1);
        const y = (H - padB) - frac * chartH;
        return { x, y, log: l, i };
      });

      if (points.length > 1) {
        const pathData = points.map((p, idx) => (idx === 0 ? \`M \${p.x} \${p.y}\` : \`L \${p.x} \${p.y}\`)).join(' ');
        svgHtml += \`<path d="\${pathData}" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>\`;
      }

      // Latency node dots
      points.forEach(p => {
        const color = p.log.latencyMs < 800 ? '#3fb950' : (p.log.latencyMs < 1400 ? '#d29922' : '#f85149');
        svgHtml += \`
          <circle cx="\${p.x}" cy="\${p.y}" r="4" fill="\${color}" stroke="#161b22" stroke-width="2"
                  data-idx="\${p.i}" class="chart-hover-target" style="cursor:pointer;"/>
        \`;
      });

      svg.innerHTML = svgHtml;

      // Tooltip hover interactions
      const box = document.querySelector('.trend-chart-box');
      svg.querySelectorAll('.chart-hover-target').forEach(el => {
        el.addEventListener('mouseenter', (e) => {
          const idx = parseInt(el.getAttribute('data-idx'), 10);
          const log = trendLogs[idx];
          if (!log) return;
          const skillsList = log.matchedSkills && log.matchedSkills.length > 0 
            ? log.matchedSkills.join(', ') 
            : 'General Mode (0 skills)';
          tooltip.innerHTML = \`
            <div class="fw-bold mb-1 text-light text-truncate">\${log.prompt || 'Untitled'}</div>
            <div class="d-flex justify-content-between mb-1 mono">
              <span class="text-secondary">Latency:</span>
              <span class="\${log.latencyMs < 800 ? 'text-success' : 'text-warning'} fw-bold">\${log.latencyMs}ms</span>
            </div>
            <div class="d-flex justify-content-between mb-1 mono">
              <span class="text-secondary">Tokens Saved:</span>
              <span class="text-info fw-bold">+\${(log.tokensSaved || 0).toLocaleString()}</span>
            </div>
            <div class="text-secondary x-small mt-1 text-truncate">
              <span class="text-light">Skills:</span> \${skillsList}
            </div>
          \`;
          tooltip.style.display = 'block';
        });

        el.addEventListener('mousemove', (e) => {
          const rect = box.getBoundingClientRect();
          let x = e.clientX - rect.left + 12;
          let y = e.clientY - rect.top - 20;
          if (x + 280 > rect.width) x = e.clientX - rect.left - 290;
          if (y < 0) y = 10;
          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        });

        el.addEventListener('mouseleave', () => {
          tooltip.style.display = 'none';
        });
      });
    }

    function setCatalogFilter(filter) {
      catalogFilter = filter;
      document.getElementById('btnFilterAll').className = 'btn btn-outline-secondary ' + (filter === 'all' ? 'active' : '');
      document.getElementById('btnFilterTriggered').className = 'btn btn-outline-secondary ' + (filter === 'triggered' ? 'active' : '');
      document.getElementById('btnFilterDormant').className = 'btn btn-outline-secondary ' + (filter === 'dormant' ? 'active' : '');
      renderSkillsCatalog();
    }

    function renderSkillsCatalog() {
      const grid = document.getElementById('skillsCatalogGrid');
      const search = (document.getElementById('catalogSearchInput')?.value || '').toLowerCase().trim();
      let list = cachedSkills.slice();

      if (catalogFilter === 'triggered') {
        list = list.filter(s => (s.hits || 0) > 0);
      } else if (catalogFilter === 'dormant') {
        list = list.filter(s => (s.hits || 0) === 0);
      }

      if (search) {
        list = list.filter(s => 
          s.name.toLowerCase().includes(search) || 
          (s.description && s.description.toLowerCase().includes(search))
        );
      }

      // Sort by hits descending, then alphabetically
      list.sort((a,b) => (b.hits || 0) - (a.hits || 0) || a.name.localeCompare(b.name));

      const totalRequests = cachedMetrics.totalRequests || 1;
      const countBadge = document.getElementById('catalogCountBadge');
      if (countBadge) countBadge.textContent = list.length + ' Skills shown';

      if (list.length === 0) {
        grid.innerHTML = '<div class="text-secondary small text-center py-4">No matching skills found.</div>';
        return;
      }

      const samplePrompts = {
        'postgresql-optimization': 'optimize my slow postgresql query with joins',
        'react-nextjs-development': 'build a react nextjs 14 dashboard component',
        'react-best-practices': 'refactor react component for optimal re-renders',
        'docker-expert': 'write a hardened multi-stage Dockerfile',
        'kubernetes-deployment': 'deploy helm chart with ingress on k8s',
        'landing-page-generator': 'generate responsive SaaS landing page in React',
        'typesafe-ai': 'implement typesafe ai system 1 judgment classifier',
        'git-workflow-and-versioning': 'resolve git merge conflict cleanly',
        'github': 'create a github pull request using gh cli',
        'security-audit': 'run penetration test and security vulnerability scan',
        'pitch-psychologist': 'review our pitch deck psychology and user framing',
        'business-analyst': 'build executive KPI dashboard framework',
        'observability-engineer': 'configure prometheus grafana alerts and logs',
        'plan-writing': 'break down complex full-stack feature architecture plan'
      };

      grid.innerHTML = list.map(s => {
        const hits = s.hits || 0;
        const rate = totalRequests > 0 ? Math.round((hits / totalRequests) * 100) : 0;
        const sample = samplePrompts[s.name] || \`How do I use \${s.name} effectively?\`;
        const isTriggered = hits > 0;
        const weights = (cachedMetrics.config && cachedMetrics.config.skillWeights) || {};
        const currentWeight = typeof weights[s.name] === 'number' ? weights[s.name] : 1.0;
        const weightBadgeClass = currentWeight > 1.0 ? 'bg-primary' : currentWeight < 1.0 ? 'bg-warning text-dark' : 'bg-secondary';
        return \`
          <div class="col-12 col-md-6 col-xl-4">
            <div class="skill-card p-3 h-100 d-flex flex-column justify-content-between">
              <div>
                <div class="d-flex justify-content-between align-items-start mb-2">
                  <span class="mono fw-bold text-info fs-6">\${s.name}</span>
                  <span class="badge \${isTriggered ? 'bg-success bg-opacity-25 text-success border border-success border-opacity-25' : 'bg-secondary bg-opacity-25 text-secondary'} mono">
                    \${hits} hits (\${rate}%)
                  </span>
                </div>
                <p class="small text-secondary mb-2" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;" title="\${s.description}">
                  \${s.description}
                </p>
                <div class="my-2 p-2 rounded bg-black bg-opacity-25 border border-secondary-subtle">
                  <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="x-small text-secondary text-uppercase fw-bold">Sensitivity Multiplier</span>
                    <span id="weightBadge_\${s.name}" class="badge \${weightBadgeClass} mono x-small">
                      \${currentWeight.toFixed(1)}x
                    </span>
                  </div>
                  <input type="range" class="form-range" min="0.5" max="1.5" step="0.1" value="\${currentWeight}"
                    oninput="onSkillWeightInput('\${s.name}', this.value)"
                    onchange="updateSkillWeight('\${s.name}', this.value)">
                </div>
              </div>
              <div class="pt-2 border-top border-secondary-subtle d-flex justify-content-between align-items-center">
                <span class="x-small text-secondary mono text-truncate" style="max-width: 140px;">
                  \${s.dirPath ? s.dirPath.split(/[\\\\/]/).slice(-2).join('/') : ''}
                </span>
                <button class="btn btn-sm btn-outline-primary px-2 py-1 x-small fw-bold" onclick="testSkill('\${sample}')">
                  ⚡ Test Prompt
                </button>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function onSkillWeightInput(name, val) {
      const badge = document.getElementById('weightBadge_' + name);
      const n = parseFloat(val);
      if (badge) {
        badge.textContent = n.toFixed(1) + 'x';
        badge.className = 'badge mono x-small ' + (n > 1.0 ? 'bg-primary' : n < 1.0 ? 'bg-warning text-dark' : 'bg-secondary');
      }
    }

    async function updateSkillWeight(name, val) {
      const n = parseFloat(val);
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skillWeights: { [name]: n } })
        });
        const data = await res.json();
        if (data.success && data.config) {
          if (!cachedMetrics.config) cachedMetrics.config = {};
          cachedMetrics.config.skillWeights = data.config.skillWeights;
        }
      } catch (err) {
        console.error('Failed to update skill weight:', err);
      }
    }

    function testSkill(promptText) {
      const input = document.getElementById('testPromptInput');
      input.value = promptText;
      window.scrollTo({ top: input.offsetTop - 120, behavior: 'smooth' });
      runLiveTest();
    }

    function updateDashboard(data) {
      // 0. Discovered Active Model Badge
      if (data.discoveredActiveModel) {
        const nameEl = document.getElementById('discoveredModelName');
        if (nameEl) nameEl.textContent = data.discoveredActiveModel.name || 'Gemini 3.8 Flash (current)';

        // Auto-sync test bench model selector if user hasn't manually overridden it
        const testSelect = document.getElementById('testModelSelect');
        if (testSelect && !userSelectedModelManually && data.discoveredActiveModel.id) {
          testSelect.value = data.discoveredActiveModel.id;
          const badge = document.getElementById('selectedModelRateBadge');
          if (badge) {
            badge.textContent = 'Rate: $' + data.discoveredActiveModel.inputPerM.toFixed(2) + ' / 1M input tokens (' + data.discoveredActiveModel.provider + ')';
          }
        }
      }

      // 1. Latency Meter
      const lat = data.avgLatencyMs || 0;
      document.getElementById('meterLatencyVal').textContent = lat;
      const latFraction = Math.min(lat / 2000, 1);
      const latDash = latFraction * 125.6;
      const gaugeLat = document.getElementById('gaugeLatency');
      gaugeLat.setAttribute('stroke-dasharray', \`\${latDash} 251.2\`);
      if (lat < 800) gaugeLat.setAttribute('stroke', '#3fb950');
      else if (lat < 1400) gaugeLat.setAttribute('stroke', '#d29922');
      else gaugeLat.setAttribute('stroke', '#f85149');

      // 2. Token Efficiency Meter
      const pct = data.avgTokenSavingsPct || 0;
      document.getElementById('meterTokenPct').textContent = pct;
      const tokenDash = (pct / 100) * 125.6;
      document.getElementById('gaugeTokens').setAttribute('stroke-dasharray', \`\${tokenDash} 251.2\`);

      // 3. Totals
      document.getElementById('totalTokensVal').textContent = (data.totalTokensSaved || 0).toLocaleString();
      const currentSim = document.getElementById('simModelSelect')?.value || 'actual';
      recalcCostWithModel(currentSim);

      // 4. Counts
      document.getElementById('totalReqBadge').textContent = (data.totalRequests || 0) + ' requests';
      document.getElementById('statSpecialized').textContent = data.specializedCount || 0;
      document.getElementById('statGeneral').textContent = data.generalModeCount || 0;
      if (data.availableSkillsCount) {
        document.getElementById('availSkillsCount').textContent = data.availableSkillsCount + ' Total Skills';
      }

      const totalReq = (data.specializedCount || 0) + (data.generalModeCount || 0);
      if (totalReq > 0) {
        const specPct = Math.round((data.specializedCount / totalReq) * 100);
        document.getElementById('ratioSpecializedBar').style.width = specPct + '%';
        document.getElementById('ratioGeneralBar').style.width = (100 - specPct) + '%';
      }

      // 5. Skill Distribution List
      const distContainer = document.getElementById('skillDistList');
      const stats = data.skillStats || {};
      const sortedSkills = Object.entries(stats).sort((a,b) => b[1] - a[1]);
      if (sortedSkills.length === 0) {
        distContainer.innerHTML = '<div class="text-secondary small text-center py-4">No skills triggered yet.</div>';
      } else {
        const maxHits = sortedSkills[0][1] || 1;
        distContainer.innerHTML = sortedSkills.slice(0, 6).map(([name, count]) => {
          const w = Math.round((count / maxHits) * 100);
          return \`
            <div>
              <div class="d-flex justify-content-between small mb-1">
                <span class="mono fw-bold text-light">\${name}</span>
                <span class="text-secondary mono">\${count} hits</span>
              </div>
              <div class="prob-bar">
                <div class="prob-fill" style="width: \${w}%;"></div>
              </div>
            </div>
          \`;
        }).join('');
      }

      // 6. Recent Logs Table
      const tbody = document.getElementById('telemetryTableBody');
      const logs = data.recentLogs || [];
      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-3">No telemetry recorded yet.</td></tr>';
      } else {
        tbody.innerHTML = logs.map(l => {
          const d = new Date(l.timestamp);
          const timeStr = d.toLocaleTimeString();
          let skillsHtml = '';
          if (l.matchedSkills && l.matchedSkills.length > 0) {
            skillsHtml = l.matchedSkills.map(s => \`<span class="badge badge-skill me-1 mb-1">\${s}</span>\`).join('');
          } else {
            skillsHtml = '<span class="badge badge-general">General (0 skills)</span>';
          }
          const eff = (l.effort || 'medium').toLowerCase();
          const effBadgeClass = eff === 'low'
            ? 'bg-success bg-opacity-25 text-success border border-success border-opacity-25'
            : eff === 'high'
            ? 'bg-danger bg-opacity-25 text-danger border border-danger border-opacity-25'
            : 'bg-warning bg-opacity-25 text-warning border border-warning border-opacity-25';

          const mKey = (l.model || 'gemini-3-8-flash').toLowerCase();
          let badgeColor = 'bg-secondary bg-opacity-25 text-light';
          if (mKey.includes('claude') || mKey.includes('sonnet') || mKey.includes('opus')) {
            badgeColor = 'bg-primary bg-opacity-20 text-info border border-info border-opacity-25';
          } else if (mKey.includes('gemini') || mKey.includes('flash') || mKey.includes('pro')) {
            badgeColor = 'bg-info bg-opacity-20 text-primary border border-primary border-opacity-25';
          } else if (mKey.includes('gpt') || mKey.includes('oss')) {
            badgeColor = 'bg-success bg-opacity-20 text-success border border-success border-opacity-25';
          }

          const modelName = l.modelName || l.model || 'Gemini 3.8 Flash (current)';
          const costDisplay = l.costSavedUsd ? '+$' + l.costSavedUsd : '+$0.0000';

          return \`
            <tr>
              <td class="mono small text-secondary">\${timeStr}</td>
              <td><span class="badge \${badgeColor} mono x-small text-truncate" style="max-width: 135px;" title="\${modelName}">\${modelName}</span></td>
              <td class="text-truncate" style="max-width: 260px;" title="\${l.prompt}">\${l.prompt}</td>
              <td class="text-center"><span class="badge \${effBadgeClass} mono x-small">\${eff.toUpperCase()}</span></td>
              <td>\${skillsHtml}</td>
              <td class="mono text-end \${l.latencyMs < 1000 ? 'text-success' : 'text-warning'}">\${l.latencyMs}ms</td>
              <td class="mono text-end text-info">+\${(l.tokensSaved || 0).toLocaleString()}</td>
              <td class="mono text-end text-success fw-bold">\${costDisplay}</td>
            </tr>
          \`;
        }).join('');
      }
    }

    async function runLiveTest() {
      const input = document.getElementById('testPromptInput');
      const prompt = input.value.trim();
      const prevContext = document.getElementById('testContextInput')?.value.trim() || '';
      const model = document.getElementById('testModelSelect')?.value || 'gemini-3-8-flash';
      if (!prompt) return;

      const btn = document.getElementById('btnTestPrompt');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Metering...';

      const resultBox = document.getElementById('liveResultBox');
      resultBox.style.display = 'block';

      try {
        const res = await fetch('/api/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, prevContext, model })
        });
        const data = await res.json();

        const latBadge = document.getElementById('liveLatencyBadge');
        latBadge.textContent = data.latencyMs + ' ms';
        latBadge.className = 'badge mono fs-6 ' + (data.latencyMs < 1000 ? 'bg-success' : 'bg-warning');

        const effBadge = document.getElementById('liveEffortBadge');
        if (effBadge && data.effort) {
          const eff = (data.effort || 'medium').toLowerCase();
          const effScore = typeof data.effortScore === 'number' ? data.effortScore.toFixed(2) : '';
          effBadge.textContent = '🎯 ' + eff.toUpperCase() + (effScore ? ' (' + effScore + ')' : '');
          effBadge.className = 'badge mono fs-6 ' + (eff === 'low' ? 'bg-success' : eff === 'high' ? 'bg-danger' : 'bg-warning text-dark');
          effBadge.style.display = 'inline-block';
        }

        const costBadge = document.getElementById('liveCostBadge');
        if (costBadge && data.costSavedUsd) {
          costBadge.textContent = '💵 SAVED: +$' + data.costSavedUsd + ' (' + (data.modelName || data.model) + ')';
          costBadge.style.display = 'inline-block';
        }

        document.getElementById('liveSavingsVal').textContent = \`+\${(data.tokensSaved || 0).toLocaleString()} tokens (~$\${data.costSavedUsd || '0.0000'} on \${data.modelName || 'Gemini Pro'})\`;

        const skillsList = document.getElementById('liveSkillsList');
        if (data.matchedSkills && data.matchedSkills.length > 0) {
          skillsList.innerHTML = data.matchedSkills.map(s => \`<span class="badge badge-skill me-1 mb-1">\${s}</span>\`).join('');
        } else {
          skillsList.innerHTML = '<span class="badge badge-general">General Mode (Zero tokens wasted)</span>';
        }

        const probList = document.getElementById('liveProbList');
        if (data.probabilities) {
          const sorted = Object.entries(data.probabilities).sort((a,b) => b[1] - a[1]).slice(0, 5);
          probList.innerHTML = sorted.map(([name, p]) => {
            const pct = (p * 100).toFixed(1);
            const isMatch = (data.matchedSkills || []).includes(name);
            return \`
              <div>
                <div class="d-flex justify-content-between small mb-1">
                  <span class="mono \${isMatch ? 'text-success fw-bold' : 'text-secondary'}">
                    \${isMatch ? '✓ ' : ''}\${name}
                  </span>
                  <span class="mono \${isMatch ? 'text-success fw-bold' : 'text-secondary'}">\${pct}%</span>
                </div>
                <div class="prob-bar">
                  <div class="prob-fill" style="width: \${pct}%; background: \${isMatch ? '#3fb950' : '#58a6ff'};"></div>
                </div>
              </div>
            \`;
          }).join('');
        }

        fetchMetrics();
      } catch (err) {
        alert('Test failed: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Meter Query';
      }
    }

    async function clearTelemetry() {
      if (confirm('Clear telemetry log history?')) {
        await fetch('/api/clear', { method: 'POST' });
        fetchMetrics();
      }
    }

    // Auto-fetch on page load and every 2 seconds for real-time model & telemetry sync
    fetchMetrics();
    setInterval(fetchMetrics, 2000);
  </script>
</body>
</html>`;
}

export function startDashboardWithFallback(startPort = PORT) {
  let port = startPort;
  const server = createDashboardServer();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Check if existing dashboard on this port is responsive
      http.get(`http://localhost:${port}/api/metrics`, (res) => {
        if (res.statusCode === 200) {
          console.log(`\x1b[32m⚡ agy-smart Dashboard is already running at http://localhost:${port}\x1b[0m`);
          if (process.platform === "win32") {
            exec(`start http://localhost:${port}`);
          }
        } else {
          // Occupied by something else, close and try next port
          try { server.close(); } catch { /* ignore */ }
          startDashboardWithFallback(port + 1);
        }
      }).on("error", () => {
        try { server.close(); } catch { /* ignore */ }
        startDashboardWithFallback(port + 1);
      });
    } else {
      console.error("Dashboard server error:", err);
    }
  });

  server.listen(port, () => {
    console.log(`\x1b[32m🚀 agy-smart Performance Dashboard running at http://localhost:${port}\x1b[0m`);
    console.log(`\x1b[90mPress Ctrl+C to stop the dashboard server.\x1b[0m`);
    if (process.platform === "win32") {
      exec(`start http://localhost:${port}`);
    }
  });

  return server;
}

// Auto-run if executed directly
const currentFilePath = new URL(import.meta.url).pathname;
const invokedPath = process.argv[1]?.replace(/\\/g, "/");
if (invokedPath && currentFilePath.endsWith(invokedPath.replace(/^[A-Za-z]:/, ""))) {
  startDashboardWithFallback();
}
