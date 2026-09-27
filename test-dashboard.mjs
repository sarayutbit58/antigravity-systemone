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
    console.log("  ✓ GET / (HTML Dashboard rendered)");

    // 2. Test GET /api/metrics
    const metricsRes = await get("/api/metrics");
    assert.equal(metricsRes.status, 200, "/api/metrics should return 200");
    const metrics = JSON.parse(metricsRes.body);
    assert.ok(typeof metrics.avgLatencyMs === "number", "metrics.avgLatencyMs should be a number");
    assert.ok(typeof metrics.totalTokensSaved === "number", "metrics.totalTokensSaved should be a number");
    assert.ok(Array.isArray(metrics.recentLogs), "metrics.recentLogs should be an array");
    console.log(`  ✓ GET /api/metrics (Requests: ${metrics.totalRequests}, Avg Latency: ${metrics.avgLatencyMs}ms, Tokens Saved: ${metrics.totalTokensSaved})`);

    // 3. Test GET /api/skills
    const skillsRes = await get("/api/skills");
    assert.equal(skillsRes.status, 200, "/api/skills should return 200");
    const skills = JSON.parse(skillsRes.body);
    assert.ok(Array.isArray(skills), "skills should be an array");
    assert.ok(skills.length > 0, "should return scanned skills");
    console.log(`  ✓ GET /api/skills (Found ${skills.length} available skills)`);

    console.log("\n🎉 All Dashboard verification tests passed!");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.close();
  }
});
