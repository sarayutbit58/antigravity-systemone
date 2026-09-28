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
    console.log("  ✓ GET / (HTML Dashboard rendered with Timeline, Config, & Catalog)");

    // 2. Test GET /api/metrics
    const metricsRes = await get("/api/metrics");
    assert.equal(metricsRes.status, 200, "/api/metrics should return 200");
    const metrics = JSON.parse(metricsRes.body);
    assert.ok(typeof metrics.avgLatencyMs === "number", "metrics.avgLatencyMs should be a number");
    assert.ok(typeof metrics.totalTokensSaved === "number", "metrics.totalTokensSaved should be a number");
    assert.ok(Array.isArray(metrics.recentLogs), "metrics.recentLogs should be an array");
    assert.ok(Array.isArray(metrics.trendLogs), "metrics.trendLogs should be an array");
    assert.ok(metrics.config && typeof metrics.config.threshold === "number", "metrics.config should exist");
    console.log(`  ✓ GET /api/metrics (Requests: ${metrics.totalRequests}, Avg Latency: ${metrics.avgLatencyMs}ms, Tokens Saved: ${metrics.totalTokensSaved}, Trend points: ${metrics.trendLogs.length})`);

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

    const postData = JSON.stringify({ threshold: 0.45, maxSkills: 6 });
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
    console.log(`  ✓ GET & POST /api/config (Threshold updated to ${postResult.config.threshold}, MaxSkills: ${postResult.config.maxSkills})`);

    console.log("\n🎉 All Dashboard verification tests passed!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.close();
  }
});
