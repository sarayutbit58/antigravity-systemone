#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanSkills, queryJevRouter, inferEffortLevel, loadConfig, loadEnv } from "./index.mjs";
import { saveTelemetry } from "./dashboard.mjs";

// ponytail: PreInvocation fires on every model invocation (each tool-call cycle),
// not once per user message. Dedup by checking if recent telemetry already has
// the exact prompt AND stepIndex to avoid cross-conversation collision.
const TELEMETRY_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "telemetry.json");
export function alreadyLogged(prompt, stepIndex, telemetryPath = TELEMETRY_PATH) {
  try {
    const arr = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
    if (!arr.length) return false;
    if (stepIndex !== undefined && stepIndex >= 0) {
      return arr.slice(0, 10).some((e) => e.stepIndex === stepIndex && e.prompt === prompt);
    }
    return arr[0]?.prompt === prompt;
  } catch { return false; }
}

loadEnv();

async function main() {
  let inputStr = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    inputStr += chunk;
  }

  try {
    const data = JSON.parse(inputStr || "{}");
    const transcriptPath = data.transcriptPath;

    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const content = fs.readFileSync(transcriptPath, "utf8");
      const lines = content.trim().split("\n");

      // Find the most recent USER_INPUT line and previous prompt for context
      let lastUserPrompt = "";
      let prevUserPrompt = "";
      let lastStepIndex = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const step = JSON.parse(lines[i]);
          if (step.type === "USER_INPUT" && step.content) {
            const raw = step.content;
            // Extract from <USER_REQUEST> if present
            const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const text = (m ? m[1] : raw).trim();
            if (!lastUserPrompt) {
              lastUserPrompt = text;
              lastStepIndex = typeof step.step_index === "number" ? step.step_index : i;
            } else if (!prevUserPrompt && text !== lastUserPrompt) {
              prevUserPrompt = text;
              break;
            }
          }
        } catch { /* skip unparseable line */ }
      }

      if (lastUserPrompt && !alreadyLogged(lastUserPrompt, lastStepIndex)) {
        const skills = scanSkills();
        const cfg = loadConfig();
        const [result, effortResult] = await Promise.all([
          queryJevRouter(lastUserPrompt, skills, cfg, undefined, prevUserPrompt),
          inferEffortLevel(lastUserPrompt, { timeoutMs: cfg.timeoutMs, prevContext: prevUserPrompt }),
        ]);

        const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
        saveTelemetry({
          id: `ide-${Date.now()}`,
          timestamp: Date.now(),
          stepIndex: lastStepIndex,
          prompt: lastUserPrompt,
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
      }
    }
  } catch (err) {
    // Non-critical: hooks must not crash Antigravity
  }

  // Antigravity hook expects JSON on stdout
  process.stdout.write(JSON.stringify({}));
}

// ponytail: auto-run guard - only read stdin and execute when invoked directly as CLI hook script
const currentFilePath = new URL(import.meta.url).pathname;
const invokedPath = process.argv[1]?.replace(/\\/g, "/");
if (invokedPath && currentFilePath.endsWith(invokedPath.replace(/^[A-Za-z]:/, ""))) {
  main();
}
