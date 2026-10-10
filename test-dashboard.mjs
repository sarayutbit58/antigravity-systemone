import assert from "node:assert/strict";
import * as http from "node:http";
import { createDashboardServer } from "./dashboard.mjs";

console.log("🧪 Running agy-smart dashboard API verification tests...\n");

const server = createDashboardServer();
const TEST_PORT = 3739;

server.listen(TEST_PORT, async () => {
  try {
    // Helper fetcher
    const get = (path) => new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}${path}`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }).on("error", reject);
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
    assert.ok(htmlRes.body.includes("Real Cost Saved"), "HTML should contain Real Cost Saved label");
    console.log("  ✓ GET / (HTML Dashboard rendered with Timeline, Config, Catalog, Sensitivity Sliders, Effort & Real Model Pricing)");

    // 2. Test GET /api/metrics
    const metricsRes = await get("/api/metrics");
    assert.equal(metricsRes.status, 200, "/api/metrics should return 200");
    const metrics = JSON.parse(metricsRes.body);
    assert.ok(typeof metrics.avgLatencyMs === "number", "metrics.avgLatencyMs should be a number");
    assert.ok(typeof metrics.totalTokensSaved === "number", "metrics.totalTokensSaved should be a number");
    assert.ok(typeof metrics.estimatedCostSavedUsd === "string", "metrics.estimatedCostSavedUsd should be formatted string");
    assert.ok(Array.isArray(metrics.models), "metrics.models should be an array");
    assert.ok(metrics.models.length > 0, "metrics.models should contain pricing catalog");
    assert.ok(Array.isArray(metrics.recentLogs), "metrics.recentLogs should be an array");
    assert.ok(Array.isArray(metrics.trendLogs), "metrics.trendLogs should be an array");
    assert.ok(metrics.config && typeof metrics.config.threshold === "number", "metrics.config should exist");
    console.log(`  ✓ GET /api/metrics (Requests: ${metrics.totalRequests}, Avg Latency: ${metrics.avgLatencyMs}ms, Tokens Saved: ${metrics.totalTokensSaved}, Est Cost Saved: $${metrics.estimatedCostSavedUsd}, Models: ${metrics.models.length})`);

    // 2.5 Test GET /api/models and search
    const modelsRes = await get("/api/models");
    assert.equal(modelsRes.status, 200, "/api/models should return 200");
    const modelsList = JSON.parse(modelsRes.body);
    assert.ok(Array.isArray(modelsList) && modelsList.length >= 10, "Should list all standard models");
    const claudeSearchRes = await get("/api/models?q=claude");
    const claudeList = JSON.parse(claudeSearchRes.body);
    assert.ok(claudeList.length > 0 && claudeList.every(m => m.name.toLowerCase().includes("claude") || m.provider.toLowerCase().includes("anthropic")), "Search query should filter models");
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

    const postData = JSON.stringify({ threshold: 0.45, maxSkills: 6, skillWeights: { "docker-expert": 1.4 } });
    const postRes = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
    assert.equal(postRes.status, 200, "/api/config POST should return 200");
    const postResult = JSON.parse(postRes.body);
    assert.equal(postResult.success, true);
    assert.equal(postResult.config.threshold, 0.45);
    assert.equal(postResult.config.maxSkills, 6);
    assert.equal(postResult.config.skillWeights["docker-expert"], 1.4);
    // Restore initial config
    await new Promise((resolve) => {
      const req = http.request(`http://localhost:${TEST_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }, (res) => resolve(res));
      req.write(JSON.stringify(initialConfig));
      req.end();
    });
    console.log(`  ✓ GET & POST /api/config (Threshold: ${postResult.config.threshold}, MaxSkills: ${postResult.config.maxSkills}, SkillWeight: docker-expert=${postResult.config.skillWeights["docker-expert"]}x)`);

    // 5. Test POST /api/test endpoint structure with model pickup
    const testPostData = JSON.stringify({ prompt: "continue", prevContext: "build docker container", model: "claude-3-7-sonnet" });
    const testRes = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${TEST_PORT}/api/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(testPostData) }
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.write(testPostData);
      req.end();
    });
    assert.equal(testRes.status, 200, "/api/test should return 200");
    const testResult = JSON.parse(testRes.body);
    assert.ok(Array.isArray(testResult.matchedSkills), "matchedSkills should be array");
    assert.ok(typeof testResult.latencyMs === "number", "latencyMs should be number");
    assert.ok(["low", "medium", "high"].includes(testResult.effort), "effort should be low, medium, or high");
    assert.equal(testResult.model, "claude-3-7-sonnet", "should echo picked model");
    assert.equal(testResult.modelRate, 3.00, "Claude 3.7 Sonnet rate should be $3.00/1M tokens");
    assert.ok(typeof testResult.costSavedUsd === "string", "costSavedUsd should be returned");
    console.log(`  ✓ POST /api/test with model pickup (Latency: ${testResult.latencyMs}ms, Effort: ${testResult.effort.toUpperCase()}, Model: ${testResult.modelName} @ $${testResult.modelRate}/1M, Saved: $${testResult.costSavedUsd})`);

    console.log("\n🎉 All Dashboard verification tests passed!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.close();
  }
});
