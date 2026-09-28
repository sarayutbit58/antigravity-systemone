import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractUserPrompt,
  parseFlags,
  loadConfig,
  saveConfig,
  scanSkills,
  createSkillsConfig,
  restoreSkillsConfig,
  queryJevRouter,
} from "./index.mjs";

console.log("🧪 Running agy-smart verification tests (live-only mode)...\n");

// ─── Test 1: parseFlags ─────────────────────────────────────────────────────
{
  const r1 = parseFlags(["--verbose", "-p", "hello", "--dry-run", "--effort", "high"]);
  assert.equal(r1.verbose, true);
  assert.equal(r1.dryRun, true);
  assert.deepEqual(r1.agyArgs, ["-p", "hello", "--effort", "high"]);

  const r2 = parseFlags(["-i", "test prompt"]);
  assert.equal(r2.verbose, false);
  assert.equal(r2.dryRun, false);
  assert.deepEqual(r2.agyArgs, ["-i", "test prompt"]);
  console.log("  ✓ parseFlags");
}

// ─── Test 2: extractUserPrompt ──────────────────────────────────────────────
{
  assert.equal(extractUserPrompt(["-p", "hello world", "--effort", "high"]), "hello world");
  assert.equal(extractUserPrompt(["--prompt-interactive", "debug app"]), "debug app");
  assert.equal(extractUserPrompt(["optimize", "postgresql"]), "optimize postgresql");
  console.log("  ✓ extractUserPrompt");
}

// ─── Test 3: loadConfig ─────────────────────────────────────────────────────
{
  const cfg = loadConfig();
  assert.equal(typeof cfg.threshold, "number");
  assert.equal(typeof cfg.timeoutMs, "number");
  assert.equal(typeof cfg.maxSkills, "number");
  assert.equal(typeof cfg.verbose, "boolean");
  assert.ok(cfg.threshold > 0 && cfg.threshold <= 1, "threshold in (0,1]");
  assert.ok(cfg.maxSkills >= 1, "maxSkills >= 1");
  console.log(`  ✓ loadConfig (threshold=${cfg.threshold}, timeout=${cfg.timeoutMs}ms, max=${cfg.maxSkills})`);
}

// ─── Test 3b: saveConfig ────────────────────────────────────────────────────
{
  const original = loadConfig();
  const updated = saveConfig({ threshold: 0.55, maxSkills: 8 });
  assert.equal(updated.threshold, 0.55);
  assert.equal(updated.maxSkills, 8);
  // Restore original
  saveConfig(original);
  console.log("  ✓ saveConfig (threshold & maxSkills update & restore)");
}

// ─── Test 4: scanSkills ─────────────────────────────────────────────────────
{
  const skills = scanSkills();
  assert.ok(skills.length > 0, "Should find installed skills");
  const s = skills[0];
  assert.ok(s.name && s.description && s.dirPath);
  console.log(`  ✓ scanSkills (${skills.length} skills)`);
}

// ─── Test 5: createSkillsConfig & restoreSkillsConfig ───────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smart-test-"));
  try {
    // Matched skills
    const { skillsJsonPath, originalContent } = createSkillsConfig(tmpDir, ["react-best-practices", "docker-expert"]);
    const json = JSON.parse(fs.readFileSync(skillsJsonPath, "utf8"));
    assert.deepEqual(json.entries[0].include_only, ["react-best-practices", "docker-expert"]);

    restoreSkillsConfig(skillsJsonPath, originalContent);
    assert.ok(!fs.existsSync(skillsJsonPath), "Should be cleaned up");

    // General mode
    const gen = createSkillsConfig(tmpDir, []);
    const genJson = JSON.parse(fs.readFileSync(gen.skillsJsonPath, "utf8"));
    assert.deepEqual(genJson.entries[0].exclude, [".*"]);
    restoreSkillsConfig(gen.skillsJsonPath, gen.originalContent);

    console.log("  ✓ createSkillsConfig & restoreSkillsConfig");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 6: queryJevRouter offline fallback ────────────────────────────────
{
  const cfg = { threshold: 0.5, timeoutMs: 1000, maxSkills: 5 };
  const res = await queryJevRouter("test", [{ name: "x", description: "d", dirPath: "" }], cfg, "");
  assert.equal(res.error, "TYPESAFE_API_KEY not set");
  assert.deepEqual(res.matchedSkills, []);
  assert.ok(typeof res.probabilities === "object");
  console.log("  ✓ queryJevRouter fallback (no API key)");
}

// ─── Test 7: queryJevRouter builds Noul questions (structure check) ─────────
{
  const cfg = { threshold: 0.5, timeoutMs: 100, maxSkills: 3 };
  const skills = [
    { name: "react-best-practices", description: "React perf", dirPath: "" },
    { name: "docker-expert", description: "Docker stuff", dirPath: "" },
  ];
  const res = await queryJevRouter("build a react app", skills, cfg, "fake-key-for-structure-test");
  assert.ok(res.error, "Should error with fake key");
  assert.ok(res.latencyMs >= 0, "latencyMs should be present");
  console.log(`  ✓ queryJevRouter Noul request structure (errored as expected: ${res.error.slice(0, 40)}...)`);
}

console.log("\n🎉 All agy-smart tests passed (live-only mode)!");
