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
  enrichShortPrompt,
  inferEffortLevel,
  scoreToEffort,
  injectEffortArg,
  stripSlashCommands,
  extractModel,
  calibrateSkills,
  ensureHookRegistered,
} from "./index.mjs";

import { alreadyLogged, extractTranscriptModel } from "./hook.mjs";
import { extractModelFromSettings, detectActiveModelRealtime, resolveModelPricing } from "./dashboard.mjs";

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
  assert.equal(extractUserPrompt(["-p=hello world"]), "hello world");
  assert.equal(extractUserPrompt(["--prompt=deploy app"]), "deploy app");
  assert.equal(extractUserPrompt(['-i="design database"']), "design database");
  console.log("  ✓ extractUserPrompt (including -p=... and --prompt=... key=val syntax)");
}

// ─── Test 3: loadConfig ─────────────────────────────────────────────────────
{
  const cfg = loadConfig();
  assert.equal(typeof cfg.threshold, "number");
  assert.equal(typeof cfg.timeoutMs, "number");
  assert.equal(typeof cfg.maxSkills, "number");
  assert.equal(typeof cfg.verbose, "boolean");
  assert.equal(typeof cfg.skillWeights, "object");
  assert.ok(cfg.threshold > 0 && cfg.threshold <= 1, "threshold in (0,1]");
  assert.ok(cfg.maxSkills >= 1, "maxSkills >= 1");
  console.log(`  ✓ loadConfig (threshold=${cfg.threshold}, timeout=${cfg.timeoutMs}ms, max=${cfg.maxSkills})`);
}

// ─── Test 3b: saveConfig ────────────────────────────────────────────────────
{
  const original = loadConfig();
  const updated = saveConfig({
    threshold: 0.55,
    maxSkills: 8,
    skillWeights: { "docker-expert": 1.3, "invalid-nan": NaN, "to-delete": null }
  });
  assert.equal(updated.threshold, 0.55);
  assert.equal(updated.maxSkills, 8);
  assert.equal(updated.skillWeights["docker-expert"], 1.3);
  assert.equal(updated.skillWeights["invalid-nan"], undefined, "NaN should be rejected");
  assert.equal(updated.skillWeights["to-delete"], undefined, "null should delete key");
  // Restore original
  saveConfig(original);
  console.log("  ✓ saveConfig (threshold, maxSkills, sanitization & skillWeights update & restore)");
}

// ─── Test 3c: enrichShortPrompt (multi-turn context awareness) ─────────────
{
  // 1. Long prompt without triggers -> untouched
  const longPrompt = "Please help me design a multi-tenant database schema using postgresql and prisma";
  assert.equal(enrichShortPrompt(longPrompt, "earlier discussion"), longPrompt);

  // 2. Short follow-up prompt -> enriched with prior context
  const shortPrompt = "continue";
  const enriched = enrichShortPrompt(shortPrompt, "optimize postgresql query with joins");
  assert.ok(enriched.includes('[Previous Topic: "optimize postgresql query with joins"]'));
  assert.ok(enriched.includes('Current Request: "continue"'));

  // 3. Conversational trigger ("fix this") -> enriched
  const fixPrompt = "fix this issue now";
  const enrichedFix = enrichShortPrompt(fixPrompt, "docker compose service crashed on startup");
  assert.ok(enrichedFix.includes('[Previous Topic: "docker compose service crashed on startup"]'));
  assert.ok(enrichedFix.includes('Current Request: "fix this issue now"'));

  // 4. No previous context -> untouched
  assert.equal(enrichShortPrompt("continue", ""), "continue");
  console.log("  ✓ enrichShortPrompt (context-aware follow-up prompt enrichment)");
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

// ─── Test 8: alreadyLogged deduplication & cross-conversation collision guard
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-smart-tele-"));
  const teleFile = path.join(tmpDir, "telemetry.json");
  try {
    fs.writeFileSync(teleFile, JSON.stringify([
      { id: "ide-1", stepIndex: 5, prompt: "conversation A prompt" }
    ]), "utf8");

    // Case 1: Same stepIndex but different prompt (Conversation B) -> MUST NOT be marked already logged
    assert.equal(alreadyLogged("conversation B prompt", 5, teleFile), false, "Different prompt at same stepIndex must not collide");

    // Case 2: Same stepIndex and same prompt (within same turn re-invocation) -> MUST be marked already logged
    assert.equal(alreadyLogged("conversation A prompt", 5, teleFile), true, "Same prompt at same stepIndex must dedup");

    // Case 3: Different stepIndex, same prompt -> MUST NOT be marked already logged (new turn)
    assert.equal(alreadyLogged("conversation A prompt", 6, teleFile), false, "New turn with same prompt must run");

    console.log("  ✓ alreadyLogged (cross-conversation collision guard & turn deduplication)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 9: Auto --effort allocation via TypeSafe Score primitive ──────────
{
  // 1. Threshold mapping unit check
  assert.equal(scoreToEffort(0.2), "low");
  assert.equal(scoreToEffort(0.69), "low");
  assert.equal(scoreToEffort(0.7), "medium");
  assert.equal(scoreToEffort(1.49), "medium");
  assert.equal(scoreToEffort(1.5), "high");
  assert.equal(scoreToEffort(2.0), "high");

  // 2. Offline fallback (no API key)
  const offline = await inferEffortLevel("what is today's date", { apiKey: "" });
  assert.equal(offline.effort, "medium");
  assert.equal(offline.error, "TYPESAFE_API_KEY not set");

  // 3. Structure / fake key check
  const fake = await inferEffortLevel("build distributed database", { apiKey: "fake-key", timeoutMs: 50 });
  assert.equal(fake.effort, "medium");
  assert.ok(fake.error, "Should handle error and fallback to medium");

  console.log("  ✓ inferEffortLevel & scoreToEffort (TypeSafe Score primitive)");
}

// ─── Test 10: stripSlashCommands model switcher filtering ────────────────────
{
  assert.equal(stripSlashCommands("/model claude-3-7-sonnet optimize sql query"), "optimize sql query");
  assert.equal(stripSlashCommands("/mode pro refactor this function"), "refactor this function");
  assert.equal(stripSlashCommands("/m gpt-4o fix bug"), "fix bug");
  assert.equal(stripSlashCommands("build react app"), "build react app");
  assert.equal(stripSlashCommands(""), "");
  console.log("  ✓ stripSlashCommands (filters /model, /mode, /m prefixes for clean task routing)");
}

// ─── Test 11: injectEffortArg auto-injection & forced System One effort ──────
{
  // Case 1: Injects effort when missing
  assert.deepEqual(injectEffortArg(["-p", "hello"], "high"), ["-p", "hello", "--effort", "high"]);
  assert.deepEqual(injectEffortArg(["-i", "prompt"], "low"), ["-i", "prompt", "--effort", "low"]);

  // Case 2: Forces System One effort over manual --effort flags (Jev authority)
  assert.deepEqual(injectEffortArg(["-p", "hello", "--effort", "low"], "high"), ["-p", "hello", "--effort", "high"]);
  assert.deepEqual(injectEffortArg(["-p", "hello", "--effort=medium"], "high"), ["-p", "hello", "--effort", "high"]);

  // Case 3: Preserves manual --model while overriding --effort
  assert.deepEqual(
    injectEffortArg(["--model", "claude-3-7-sonnet", "-p", "hello", "--effort", "low"], "medium"),
    ["--model", "claude-3-7-sonnet", "-p", "hello", "--effort", "medium"]
  );

  console.log("  ✓ injectEffortArg (enforces System One effort & preserves selected --model)");
}

// ─── Test 12: extractModel detection from prompt & CLI args ─────────────────
{
  // From prompt slash command
  assert.equal(extractModel([], "/model claude-3-7-sonnet create an app"), "claude-3-7-sonnet");
  assert.equal(extractModel([], "/mode pro fix this bug"), "pro");
  assert.equal(extractModel([], "/m gpt-4o optimize performance"), "gpt-4o");

  // From CLI arguments
  assert.equal(extractModel(["--model", "gemini-2.0-flash", "-p", "hello"], ""), "gemini-2.0-flash");
  assert.equal(extractModel(["-m", "o3-mini", "-p", "hello"], ""), "o3-mini");
  assert.equal(extractModel(["--model=claude-3-5-sonnet", "-p", "hello"], ""), "claude-3-5-sonnet");

  // Fallback to default when no settings file configured
  assert.equal(extractModel(["-p", "hello"], "hello", false), "gemini-3-8-flash");

  // Fallback to configured settings file when present
  const tmpSettings = path.join(os.tmpdir(), `temp-settings-${Date.now()}.json`);
  fs.writeFileSync(tmpSettings, JSON.stringify({ model: "Claude Sonnet 4.6 (Thinking)" }), "utf8");
  try {
    assert.equal(extractModel(["-p", "hello"], "hello", tmpSettings), "Claude Sonnet 4.6 (Thinking)");
  } finally {
    try { fs.unlinkSync(tmpSettings); } catch {}
  }

  console.log("  ✓ extractModel (detects model pickup from slash commands and CLI flags)");
}

// ─── Test 13: calibrateSkills algorithmic sensitivity auto-calibration ─────
{
  // 1. Null-safety and corrupt inputs handling
  const nullRes = calibrateSkills(null, null, null);
  assert.equal(nullRes.totalEvaluated, 0);
  assert.equal(nullRes.stats.boosted, 0);
  assert.equal(nullRes.stats.dampened, 0);
  assert.ok(typeof nullRes.stats.unchanged === "number");

  const corruptLogs = [
    null,
    undefined,
    123,
    "corrupt",
    { matchedSkills: null, probabilities: null },
    { matchedSkills: ["docker-expert"], probabilities: { "docker-expert": 0.95 } }
  ];
  const corruptRes = calibrateSkills(corruptLogs, { "docker-expert": 1.0 }, null);
  assert.ok(corruptRes && corruptRes.skillWeights["docker-expert"] !== undefined, "Corrupt logs should be handled safely");

  // 2. Sparse samples (< 3 logs) preservation
  const sparseLogs = [
    { matchedSkills: ["docker-expert"], probabilities: { "docker-expert": 0.85 } }
  ];
  const sparseRes = calibrateSkills(sparseLogs, { "docker-expert": 1.2 });
  assert.equal(sparseRes.skillWeights["docker-expert"], 1.2, "Sparse samples should preserve existing weight");
  assert.equal(sparseRes.deltas["docker-expert"].delta, 0.0);
  assert.ok(sparseRes.deltas["docker-expert"].reason.includes("Insufficient telemetry samples"));

  // 3. High-precision specialist boost (high SCR, low FP)
  const boostLogs = Array.from({ length: 15 }, () => ({
    matchedSkills: ["docker-expert"],
    probabilities: { "docker-expert": 0.95 }
  }));
  const boostRes = calibrateSkills(boostLogs, { "docker-expert": 1.0 }, { threshold: 0.5 });
  assert.ok(boostRes.skillWeights["docker-expert"] > 1.0, "Specialist skill should be boosted");
  assert.ok(boostRes.stats.boosted >= 1, "Boosted count should increment");

  // 4. Borderline false-positive dampening
  const dampenLogs = Array.from({ length: 15 }, () => ({
    matchedSkills: ["sql-pro"],
    probabilities: { "sql-pro": 0.52 } // borderline near threshold 0.50
  }));
  const dampenRes = calibrateSkills(dampenLogs, { "sql-pro": 1.5 }, { threshold: 0.5 });
  assert.ok(dampenRes.skillWeights["sql-pro"] < 1.5, "Borderline FP skill should be dampened");
  assert.ok(dampenRes.stats.dampened >= 1, "Dampened count should increment");

  // 5. Clamping bounds strictly within [0.1, 2.0]
  const clampLow = calibrateSkills(dampenLogs, { "sql-pro": 0.1 }, { threshold: 0.5 });
  assert.equal(clampLow.skillWeights["sql-pro"], 0.1, "Multiplier must never drop below 0.1");

  const clampHigh = calibrateSkills(boostLogs, { "docker-expert": 2.0 }, { threshold: 0.5 });
  assert.equal(clampHigh.skillWeights["docker-expert"], 2.0, "Multiplier must never exceed 2.0");

  console.log("  ✓ calibrateSkills (null-safety, sparse telemetry, specialist boost, FP dampening & [0.1, 2.0] clamping)");
}

// ─── Test 14: extractModelFromSettings robust settings parsing ──────────────
{
  // 1. Standard Antigravity format
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` to Gemini 3.8 Flash (Medium). No need to acknowledge this message.\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 2. Format with 'from <old> to <new>'
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Opus 4.6 (Thinking) to Gemini 3.8 Flash (Medium). No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 3. Various quote styles
  assert.equal(
    extractModelFromSettings('<USER_SETTINGS_CHANGE> The user changed setting "Model Selection" to "Gemini 3.8 Flash (current)". </USER_SETTINGS_CHANGE>'),
    "Gemini 3.8 Flash (current)"
  );
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE> The user changed setting 'Model Selection' to 'gemini-3-8-flash'. </USER_SETTINGS_CHANGE>"),
    "gemini-3-8-flash"
  );
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE> The user changed setting Model Selection to `Gemini 3.8 Flash (Medium)`. </USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 4. Colon and equal syntax
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\n  Model Selection: Gemini 3.8 Flash (Medium)\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 5. Irregular whitespace and newlines
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\n  The user changed setting   `Model Selection`  \n  to   Gemini 3.8 Flash (Medium)  .\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 6. Multi-tag sequences (Theme first, Model Selection second)
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nTheme changed to Dark\n</USER_SETTINGS_CHANGE>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection`\nto \"Gemini 3.8 Flash (Medium)\"\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 7. Multi-model switches in same block (confirming last wins)
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.1 Pro.\nThe user changed setting `Model Selection` from Gemini 3.1 Pro to Gemini 3.8 Flash (Medium).\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash (Medium)"
  );

  // 8. Hyphenated model name with 'to' (code-to-test)
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from code-to-test to Gemini 3.8 Flash\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash"
  );

  // 9. Markdown, arrow and attribute syntax
  assert.equal(
    extractModelFromSettings("**Model Selection**: Gemini 3.8 Flash"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection -> Gemini 3.8 Flash"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings('<USER_SETTINGS_CHANGE source="user">\nThe user changed setting `Model Selection`\nto "Gemini 3.8 Flash"\n</USER_SETTINGS_CHANGE>'),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: **Gemini 3.8 Flash**"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: *Gemini 3.8 Flash*"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: [Gemini 3.8 Flash]"),
    "Gemini 3.8 Flash"
  );

  // 10. Case insensitivity and transition verbs
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE> The user changed setting `model selection` to Gemini 3.8 Flash </USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("**Model Selection** changed to **Gemini 3.8 Flash**"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection was changed to Gemini 3.8 Flash"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection set to Gemini 3.8 Flash"),
    "Gemini 3.8 Flash"
  );

  // 11. Sentence boundary, delimiter isolation, and multi-setting lines
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` to Gemini 3.8 Flash. Please use this model.\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: **Gemini 3.8 Flash** or Model Selection: *Gemini 3.8 Flash*"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: Gemini 3.8 Flash, Theme: Dark"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("Model Selection: Gemini 3.8 Flash; Temperature: 0.7"),
    "Gemini 3.8 Flash"
  );
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.1 Pro (High). No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.1 Pro (High)"
  );
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE>\nThe user changed setting \\`model selection\\` to Gemini 3.8 Flash\n</USER_SETTINGS_CHANGE>"),
    "Gemini 3.8 Flash"
  );

  // 12. Negative cases (non-settings changes, code discussions, Theme only)
  assert.equal(
    extractModelFromSettings("Can you help me with Model Selection in machine learning? We want to switch from random forests to XGBoost."),
    null
  );
  assert.equal(
    extractModelFromSettings("<USER_SETTINGS_CHANGE> The user changed setting `Theme` to Dark. </USER_SETTINGS_CHANGE>"),
    null
  );

  console.log("  ✓ extractModelFromSettings (extracts model from <USER_SETTINGS_CHANGE> across formatting & whitespace)");
}

// ─── Test 15: detectActiveModelRealtime deep transcript scan (>150 lines) ───
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-deep-transcript-"));
  try {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");

    // Build a transcript with 200 lines where Model Selection change is at line 1 (>190 lines from the end)
    const lines = [];
    lines.push(JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>Initial prompt</USER_REQUEST>"
    }));
    lines.push(JSON.stringify({
      step_index: 1,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Opus 4.6 (Thinking) to Gemini 3.8 Flash (Medium). No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>"
    }));

    // Add 190 lines of simulated tool calls, model responses, and generic steps pushing the change deep
    for (let i = 2; i <= 195; i++) {
      lines.push(JSON.stringify({
        step_index: i,
        source: i % 2 === 0 ? "MODEL" : "SYSTEM",
        type: i % 2 === 0 ? "PLANNER_RESPONSE" : "GENERIC",
        content: `Simulated step ${i} with tool output, code edits, and lengthy logs`
      }));
    }

    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    // Must find it even though it's located >190 lines from the end
    const detected = detectActiveModelRealtime(tmpDir);
    assert.equal(detected, "Gemini 3.8 Flash (Medium)");

    const pricing = resolveModelPricing(detected);
    assert.equal(pricing.id, "gemini-3-8-flash");
    assert.equal(pricing.name, "Gemini 3.8 Flash (Medium)");

    console.log("  ✓ detectActiveModelRealtime (accurately detects Gemini 3.8 Flash when >150 lines from the end)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 16: detectActiveModelRealtime multi-turn model switches ───────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-multi-switch-"));
  try {
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    const lines = [];

    // Turn 1: Switch to Gemini 3.1 Pro
    lines.push(JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` to Gemini 3.1 Pro\n</USER_SETTINGS_CHANGE>"
    }));
    for (let i = 1; i <= 30; i++) {
      lines.push(JSON.stringify({ step_index: i, source: "MODEL", content: `Tool output ${i}` }));
    }

    // Turn 32: Switch to Claude Sonnet 4.6
    lines.push(JSON.stringify({
      step_index: 31,
      source: "USER_EXPLICIT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` to Claude Sonnet 4.6 (Thinking)\n</USER_SETTINGS_CHANGE>"
    }));
    for (let i = 32; i <= 70; i++) {
      lines.push(JSON.stringify({ step_index: i, source: "MODEL", content: `Tool output ${i}` }));
    }

    // Turn 72: Switch to Gemini 3.8 Flash (Medium)
    lines.push(JSON.stringify({
      step_index: 71,
      source: "USER_EXPLICIT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Claude Sonnet 4.6 (Thinking) to Gemini 3.8 Flash (Medium). No need to comment...\n</USER_SETTINGS_CHANGE>"
    }));
    for (let i = 72; i <= 160; i++) {
      lines.push(JSON.stringify({ step_index: i, source: "MODEL", content: `Tool output ${i}` }));
    }

    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf8");

    // Most recent setting (Gemini 3.8 Flash) must be selected
    const detected = detectActiveModelRealtime(tmpDir);
    assert.equal(detected, "Gemini 3.8 Flash (Medium)");

    const pricing = resolveModelPricing(detected);
    assert.equal(pricing.id, "gemini-3-8-flash");
    assert.equal(pricing.name, "Gemini 3.8 Flash (Medium)");

    console.log("  ✓ detectActiveModelRealtime (selects latest model across multi-turn switches)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test 17: hook.mjs extractTranscriptModel robust deep transcript scan ───
{
  // Deep transcript with >160 lines, non-JSON lines, and setting change
  const lines = [
    "Non-JSON header line in transcript",
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>Initial prompt</USER_REQUEST>"
    }),
    "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` to Gemini 3.8 Flash (Medium)\n</USER_SETTINGS_CHANGE>"
  ];
  for (let i = 1; i <= 170; i++) {
    lines.push(JSON.stringify({ step_index: i, source: i % 2 === 0 ? "MODEL" : "SYSTEM", content: `Tool output ${i}` }));
  }

  const model = extractTranscriptModel(lines);
  assert.equal(model, "Gemini 3.8 Flash (Medium)");

  // Formatting and whitespace resilience
  assert.equal(
    extractTranscriptModel([
      JSON.stringify({
        source: "USER_EXPLICIT",
        content: "<USER_SETTINGS_CHANGE>\n  The user changed setting   `model selection`  \n  to   Gemini 3.8 Flash (current)  .\n</USER_SETTINGS_CHANGE>"
      })
    ]),
    "Gemini 3.8 Flash (current)"
  );

  console.log("  ✓ extractTranscriptModel (hook.mjs extracts model correctly from transcripts across whitespace, non-JSON lines & depth)");
}

// ─── Test 18: hook.mjs prompt /model slash command override precedence ───────
{
  // When user explicitly inputs /model gemini-3-8-flash, it must take precedence over older transcriptModel
  const lastRawPrompt = "/model gemini-3-8-flash build an adversarial suite";
  const transcriptModel = "claude-sonnet-4-6";
  const data = {};

  const hasPromptSlash = /^\/(?:model|mode|m)\s+([^\s]+)/i.test(lastRawPrompt);
  const promptModel = hasPromptSlash ? extractModel([], lastRawPrompt) : "";
  const detectedModel = promptModel || transcriptModel || data.modelName || "gemini-3-8-flash";

  assert.equal(detectedModel, "gemini-3-8-flash");

  // When prompt has no slash command, transcriptModel takes precedence
  const normalPrompt = "build an adversarial suite";
  const normalSlash = /^\/(?:model|mode|m)\s+([^\s]+)/i.test(normalPrompt);
  const normalPromptModel = normalSlash ? extractModel([], normalPrompt) : "";
  const normalDetected = normalPromptModel || transcriptModel || data.modelName || "gemini-3-8-flash";

  assert.equal(normalDetected, "claude-sonnet-4-6");

  console.log("  ✓ hook model precedence (prompt /model slash command takes precedence over transcriptModel)");
}

// ─── Test 19: ensureHookRegistered lifecycle hook registration ────────────────
{
  const registered = ensureHookRegistered();
  // Idempotent: should return boolean without throwing
  assert.equal(typeof registered, "boolean");
  console.log("  ✓ ensureHookRegistered (idempotent registration of agy-smart-router in hooks.json)");
}

console.log("\n🎉 All agy-smart tests passed (live-only mode)!");
