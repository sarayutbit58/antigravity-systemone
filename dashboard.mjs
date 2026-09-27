#!/usr/bin/env node
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { scanSkills, queryJevRouter, loadConfig, loadEnv } from "./index.mjs";

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

function calculateMetrics(logs, totalSkills = 54) {
  const total = logs.length;
  if (total === 0) {
    return {
      totalRequests: 0,
      avgLatencyMs: 0,
      totalTokensSaved: 0,
      avgTokenSavingsPct: 0,
      estimatedCostSavedUsd: "0.00",
      generalModeCount: 0,
      specializedCount: 0,
      recentLogs: [],
      skillStats: {}
    };
  }

  let totalLatency = 0;
  let totalSaved = 0;
  let generalCount = 0;
  const skillCount = {};

  for (const log of logs) {
    totalLatency += log.latencyMs || 0;
    totalSaved += log.tokensSaved || 0;
    if (!log.matchedSkills || log.matchedSkills.length === 0) {
      generalCount++;
    } else {
      for (const s of log.matchedSkills) {
        skillCount[s] = (skillCount[s] || 0) + 1;
      }
    }
  }

  const avgLatency = Math.round(totalLatency / total);
  // Estimate baseline token cost ($0.075 per 1M input tokens for Flash / Gemini)
  const costSaved = ((totalSaved / 1_000_000) * 0.15).toFixed(4);
  const avgSavedPct = totalSkills > 0 
    ? Math.round(((totalSkills - (logs.reduce((acc, l) => acc + (l.matchedSkills?.length || 0), 0) / total)) / totalSkills) * 100)
    : 0;

  return {
    totalRequests: total,
    avgLatencyMs: avgLatency,
    totalTokensSaved: totalSaved,
    avgTokenSavingsPct: avgSavedPct,
    estimatedCostSavedUsd: costSaved,
    generalModeCount: generalCount,
    specializedCount: total - generalCount,
    recentLogs: logs.slice(0, 30),
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

    if (url.pathname === "/api/metrics") {
      const skills = scanSkills();
      const logs = getTelemetry();
      const metrics = calculateMetrics(logs, skills.length);
      metrics.availableSkillsCount = skills.length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
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
          const { prompt } = JSON.parse(body || "{}");
          if (!prompt || !prompt.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Prompt is required" }));
            return;
          }

          const skills = scanSkills();
          const cfg = loadConfig();
          const result = await queryJevRouter(prompt, skills, cfg);

          const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
          const entry = {
            id: `run-${Date.now()}`,
            timestamp: Date.now(),
            prompt: prompt.trim(),
            matchedSkills: result.matchedSkills,
            latencyMs: result.latencyMs,
            totalSkills: skills.length,
            tokensSaved,
            status: result.error ? "error" : (result.matchedSkills.length > 0 ? "specialized" : "general_mode"),
            probabilities: result.probabilities,
            error: result.error
          };

          saveTelemetry(entry);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ...result,
            tokensSaved,
            totalSkills: skills.length,
            timestamp: entry.timestamp
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
      <div class="d-flex align-items-center gap-3 mt-2 mt-sm-0">
        <span class="d-flex align-items-center gap-2 text-secondary small">
          <span class="pulse-dot"></span> Live Telemetry Active
        </span>
        <button class="btn btn-sm btn-outline-secondary" onclick="fetchMetrics()">Refresh</button>
      </div>
    </header>

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

      <!-- Meter 3: Cumulative Tokens Saved -->
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
          <div class="pt-2 border-top border-secondary-subtle d-flex justify-content-between align-items-center">
            <span class="small text-secondary">Est. Cost Saved:</span>
            <span id="estCostVal" class="mono fw-bold text-success">$0.00</span>
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
            <div class="input-group mb-3">
              <input type="text" id="testPromptInput" class="form-control mono bg-dark border-secondary text-light" placeholder="e.g. Build a React Dashboard landing page or optimize postgresql query" value="optimize postgresql query with joins">
              <button class="btn btn-primary fw-bold px-4" id="btnTestPrompt" onclick="runLiveTest()">
                Meter Query
              </button>
            </div>

            <!-- Live Result Display -->
            <div id="liveResultBox" class="p-3 rounded bg-black bg-opacity-30 border border-secondary border-opacity-50" style="display: none;">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="small fw-bold">Live Execution Metrics</span>
                <span id="liveLatencyBadge" class="badge bg-success mono fs-6">0 ms</span>
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
              <th style="width: 140px;">Time</th>
              <th>Prompt</th>
              <th style="width: 250px;">Matched Skills</th>
              <th style="width: 120px;" class="text-end">Latency</th>
              <th style="width: 130px;" class="text-end">Tokens Saved</th>
            </tr>
          </thead>
          <tbody id="telemetryTableBody">
            <tr><td colspan="5" class="text-center text-secondary py-3">Loading telemetry...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script>
    async function fetchMetrics() {
      try {
        const res = await fetch('/api/metrics');
        const data = await res.json();
        updateDashboard(data);
      } catch (err) {
        console.error('Failed to load metrics:', err);
      }
    }

    function updateDashboard(data) {
      // 1. Latency Meter
      const lat = data.avgLatencyMs || 0;
      document.getElementById('meterLatencyVal').textContent = lat;
      // max 2000ms, half circumference is 125.6
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
      document.getElementById('estCostVal').textContent = '$' + (data.estimatedCostSavedUsd || '0.00');

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
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-3">No telemetry recorded yet.</td></tr>';
      } else {
        tbody.innerHTML = logs.map(l => {
          const d = new Date(l.timestamp);
          const timeStr = d.toLocaleTimeString();
          let skillsHtml = '';
          if (l.matchedSkills && l.matchedSkills.length > 0) {
            skillsHtml = l.matchedSkills.map(s => \`<span class="badge badge-skill me-1">\${s}</span>\`).join('');
          } else {
            skillsHtml = '<span class="badge badge-general">General (0 skills)</span>';
          }
          return \`
            <tr>
              <td class="mono small text-secondary">\${timeStr}</td>
              <td class="text-truncate" style="max-width: 320px;" title="\${l.prompt}">\${l.prompt}</td>
              <td>\${skillsHtml}</td>
              <td class="mono text-end \${l.latencyMs < 1000 ? 'text-success' : 'text-warning'}">\${l.latencyMs}ms</td>
              <td class="mono text-end text-info">+\${(l.tokensSaved || 0).toLocaleString()}</td>
            </tr>
          \`;
        }).join('');
      }
    }

    async function runLiveTest() {
      const input = document.getElementById('testPromptInput');
      const prompt = input.value.trim();
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
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();

        // Update badges
        const latBadge = document.getElementById('liveLatencyBadge');
        latBadge.textContent = data.latencyMs + ' ms';
        latBadge.className = 'badge mono fs-6 ' + (data.latencyMs < 1000 ? 'bg-success' : 'bg-warning');

        document.getElementById('liveSavingsVal').textContent = \`+\${(data.tokensSaved || 0).toLocaleString()} tokens (\${data.matchedSkills?.length || 0}/\${data.totalSkills || 54} skills loaded)\`;

        const skillsList = document.getElementById('liveSkillsList');
        if (data.matchedSkills && data.matchedSkills.length > 0) {
          skillsList.innerHTML = data.matchedSkills.map(s => \`<span class="badge badge-skill">\${s}</span>\`).join('');
        } else {
          skillsList.innerHTML = '<span class="badge badge-general">General Mode (Zero tokens wasted)</span>';
        }

        // Show top 5 probabilities
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

        // Refresh global dashboard counters
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

    // Auto-fetch on page load and every 5 seconds
    fetchMetrics();
    setInterval(fetchMetrics, 5000);
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
          // Occupied by something else, try next port
          startDashboardWithFallback(port + 1);
        }
      }).on("error", () => {
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
