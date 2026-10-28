import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createDashboardServer } from "./dashboard.mjs";
import { loadConfig } from "./index.mjs";

console.log("🧪 Running agy-smart dashboard API verification tests...\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smart-test-dash-"));
const testTelemetryPath = path.join(tmpDir, "telemetry.json");
fs.writeFileSync(testTelemetryPath, JSON.stringify([], null, 2), "utf8");

const server = createDashboardServer({ telemetryPath: testTelemetryPath });

server.listen(0, async () => {
  const TEST_PORT = server.address().port;

  try {
    // Helper fetcher
    const get = (path) => new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }).on("error", reject);
    });

    const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      const reqHeaders = { "Content-Type": "application/json", ...headers };
      if (!reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
      }
      const req = http.request(`http://localhost:${TEST_PORT}${path}`, {
        method: "POST",
        headers: reqHeaders
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    // 1. Test GET /
    const htmlRes = await get("/");
    assert.equal(htmlRes.status, 200, "Dashboard HTML should return 200");
    assert.ok(htmlRes.body.includes("agy-smart"), "HTML should contain agy-smart title");
    assert.ok(htmlRes.body.includes("Avg Response Speed"), "HTML should contain meter gauge title");
    assert.ok(htmlRes.body.includes("Performance & Efficiency Timeline"), "HTML should contain trend chart");
    assert.ok(htmlRes.body.includes("Live Router Settings"), "HTML should contain config modal");
    assert.ok(htmlRes.body.includes("Skills Catalog & Routing Matrix"), "HTML should contain skills catalog");
    assert.ok(htmlRes.body.includes("Sensitivity Multiplier"), "HTML should contain sensitivity multiplier slider");
    assert.ok(htmlRes.body.includes("Effort"), "HTML should contain Effort table column");
    assert.ok(htmlRes.body.includes("PICKUP MODEL"), "HTML should contain PICKUP MODEL selector");
    assert.ok(htmlRes.body.includes("discoveredModelBadge"), "HTML should contain discoveredModelBadge element");
    assert.ok(htmlRes.body.includes("Active:"), "HTML should contain Active model indicator");

    // Assert PiP Overlay elements
    assert.ok(htmlRes.body.includes('id="pipWidget"') || htmlRes.body.includes("pip-overlay"), "HTML should contain #pipWidget");
    assert.ok(htmlRes.body.includes('id="btnTogglePip"') || htmlRes.body.includes("btnTogglePip"), "HTML should contain #btnTogglePip");
    assert.ok(htmlRes.body.includes('id="pipActiveModel"') || htmlRes.body.includes("pipActiveModel"), "HTML should contain #pipActiveModel");
    assert.ok(htmlRes.body.includes('id="pipEffortBadge"') || htmlRes.body.includes("pipEffortBadge"), "HTML should contain #pipEffortBadge");
    assert.ok(htmlRes.body.includes('id="pipCostSaved"') || htmlRes.body.includes("pipCostSaved"), "HTML should contain #pipCostSaved");
    console.log("  ✓ GET / (HTML Dashboard rendered with Timeline, Config, Catalog, PiP Widget & Discovered Active Model Badge)");

    // 2. Test GET /api/metrics
    const metricsRes = await get("/api/metrics");
    assert.equal(metricsRes.status, 200, "/api/metrics should return 200");
    const metrics = JSON.parse(metricsRes.body);
    assert.ok(typeof metrics.avgLatencyMs === "number", "metrics.avgLatencyMs should be a number");
    assert.ok(typeof metrics.totalTokensSaved === "number", "metrics.totalTokensSaved should be a number");
    assert.ok(typeof metrics.estimatedCostSavedUsd === "string", "metrics.estimatedCostSavedUsd should be formatted string");
    assert.ok(metrics.discoveredActiveModel && typeof metrics.discoveredActiveModel.name === "string", "metrics.discoveredActiveModel should exist with name");
    assert.ok(typeof metrics.discoveredActiveModel.inputPerM === "number", "metrics.discoveredActiveModel.inputPerM should be number");
    assert.ok(Array.isArray(metrics.models), "metrics.models should be an array");
    assert.ok(metrics.models.length > 0, "metrics.models should contain pricing catalog");
    assert.ok(Array.isArray(metrics.recentLogs), "metrics.recentLogs should be an array");
    assert.ok(Array.isArray(metrics.trendLogs), "metrics.trendLogs should be an array");
    assert.ok(metrics.config && typeof metrics.config.threshold === "number", "metrics.config should exist");
    console.log(`  ✓ GET /api/metrics (Requests: ${metrics.totalRequests}, Active: ${metrics.discoveredActiveModel.name}, Avg Latency: ${metrics.avgLatencyMs}ms, Tokens Saved: ${metrics.totalTokensSaved}, Est Cost Saved: $${metrics.estimatedCostSavedUsd}, Models: ${metrics.models.length})`);

    // 2.5 Test GET /api/models and search
    const modelsRes = await get("/api/models");
    assert.equal(modelsRes.status, 200, "/api/models should return 200");
    const modelsList = JSON.parse(modelsRes.body);
    assert.equal(modelsList.length, 7, "Should list exactly 7 Antigravity models");
    const claudeSearchRes = await get("/api/models?q=claude");
    const claudeList = JSON.parse(claudeSearchRes.body);
    assert.ok(claudeList.length === 2 && claudeList.every(m => m.name.toLowerCase().includes("claude") || m.provider.toLowerCase().includes("anthropic")), "Search query should filter models");
    console.log(`  ✓ GET /api/models & search (Found ${modelsList.length} models, search 'claude' returned ${claudeList.length})`);

    // 3. Test GET /api/skills
    const skillsRes = await get("/api/skills");
    assert.equal(skillsRes.status, 200, "/api/skills should return 200");
    const skills = JSON.parse(skillsRes.body);
    assert.ok(Array.isArray(skills), "skills should be an array");
    assert.ok(skills.length > 0, "should return scanned skills");
    console.log(`  ✓ GET /api/skills (Found ${skills.length} available skills)`);

    // 4. Test GET & POST /api/config
    const configGetRes = await get("/api/config");
    assert.equal(configGetRes.status, 200, "/api/config GET should return 200");
    const initialConfig = JSON.parse(configGetRes.body);
    assert.ok(typeof initialConfig.threshold === "number");

    const postRes = await post("/api/config", { threshold: 0.45, maxSkills: 6, skillWeights: { "docker-expert": 1.4 } });
    assert.equal(postRes.status, 200, "/api/config POST should return 200");
    const postResult = JSON.parse(postRes.body);
    assert.equal(postResult.success, true);
    assert.equal(postResult.config.threshold, 0.45);
    assert.equal(postResult.config.maxSkills, 6);
    assert.equal(postResult.config.skillWeights["docker-expert"], 1.4);

    // Restore initial config
    await post("/api/config", initialConfig);
    console.log(`  ✓ GET & POST /api/config (Threshold: ${postResult.config.threshold}, MaxSkills: ${postResult.config.maxSkills}, SkillWeight: docker-expert=${postResult.config.skillWeights["docker-expert"]}x)`);

    // 5. Test POST /api/test endpoint structure with model pickup
    const testPostData = { prompt: "continue", prevContext: "build docker container", model: "claude-sonnet-4-6" };
    const testRes = await post("/api/test", testPostData);
    assert.equal(testRes.status, 200, "/api/test should return 200");
    const testResult = JSON.parse(testRes.body);
    assert.ok(Array.isArray(testResult.matchedSkills), "matchedSkills should be array");
    assert.ok(typeof testResult.latencyMs === "number", "latencyMs should be number");
    assert.ok(["low", "medium", "high"].includes(testResult.effort), "effort should be low, medium, or high");
    assert.equal(testResult.model, "claude-sonnet-4-6", "should echo picked model");
    assert.equal(testResult.modelRate, 3.00, "Claude Sonnet 4.6 rate should be $3.00/1M tokens");
    assert.ok(typeof testResult.costSavedUsd === "string", "costSavedUsd should be returned");
    console.log(`  ✓ POST /api/test with model pickup (Latency: ${testResult.latencyMs}ms, Effort: ${testResult.effort.toUpperCase()}, Model: ${testResult.modelName} @ $${testResult.modelRate}/1M, Saved: $${testResult.costSavedUsd})`);

    // 6. Test GET /api/events (SSE stream & initial handshake)
    await new Promise((resolveSSE, rejectSSE) => {
      const sseReq = http.get(`http://localhost:${TEST_PORT}/api/events`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.ok((res.headers["content-type"] || "").includes("text/event-stream"), "Must return text/event-stream");
        assert.ok((res.headers["cache-control"] || "").includes("no-cache"), "Must set no-cache");

        let buffer = "";
        const timer = setTimeout(() => {
          sseReq.destroy();
          rejectSSE(new Error("Timeout waiting for SSE init event"));
        }, 3000);

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes("\n\n")) {
            const parts = buffer.split("\n\n");
            for (const part of parts) {
              if (part.includes("event: init")) {
                clearTimeout(timer);
                const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
                assert.ok(dataLine, "SSE init must include data: line");
                const data = JSON.parse(dataLine.slice(5).trim());
                assert.ok(data.metrics || data.model, "Init event data must contain model/metrics");
                sseReq.destroy();
                resolveSSE();
                return;
              }
            }
          }
        });
      });
      sseReq.on("error", (err) => {
        if (err.code !== "ECONNRESET") rejectSSE(err);
      });
    });
    console.log("  ✓ GET /api/events (SSE text/event-stream connection & initial 'init' handshake)");

    // 7. Test POST /api/config/calibrate (dry-run & apply persistence)
    const backupConfig = loadConfig();
    const dryRunRes = await post("/api/config/calibrate", { apply: false });
    assert.equal(dryRunRes.status, 200, "Calibrate dry-run should return 200");
    const dryData = JSON.parse(dryRunRes.body);
    assert.equal(dryData.success, true);
    assert.equal(dryData.applied, false);
    assert.ok(typeof dryData.skillWeights === "object");
    assert.ok(typeof dryData.deltas === "object");
    for (const [s, w] of Object.entries(dryData.skillWeights)) {
      assert.ok(w >= 0.1 && w <= 2.0, `Calibrated weight for ${s} must be in [0.1, 2.0]`);
    }

    const applyRes = await post("/api/config/calibrate", { apply: true });
    assert.equal(applyRes.status, 200, "Calibrate apply should return 200");
    const applyData = JSON.parse(applyRes.body);
    assert.equal(applyData.success, true);
    assert.equal(applyData.applied, true);

    const reloaded = loadConfig();
    for (const [s, w] of Object.entries(applyData.skillWeights)) {
      assert.equal(reloaded.skillWeights[s], w, `Persisted weight for ${s} must match`);
    }
    // Restore original config
    await post("/api/config", backupConfig);
    console.log("  ✓ POST /api/config/calibrate (dry-run recommendation, clamping [0.1, 2.0] & apply persistence)");

    // 8. Test POST /api/config/calibrate error status code (400 Bad Request)
    const badJsonRes = await post("/api/config/calibrate", "{ invalid: json...", { "Content-Type": "application/json" });
    assert.equal(badJsonRes.status, 400, "Malformed JSON must return 400 Bad Request");

    const nullBodyRes = await post("/api/config/calibrate", "null", { "Content-Type": "application/json" });
    assert.equal(nullBodyRes.status, 400, "Null body payload must return 400 Bad Request");
    console.log("  ✓ POST /api/config/calibrate error handling (returns 400 Bad Request on malformed JSON & non-object body)");

    console.log("\n🎉 All Dashboard verification tests passed!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
