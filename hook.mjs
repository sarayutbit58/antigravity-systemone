#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanSkills, queryJevRouter, loadConfig, loadEnv } from "./index.mjs";
import { saveTelemetry } from "./dashboard.mjs";

// ponytail: PreInvocation fires on every model invocation (each tool-call cycle),
// not once per user message. Dedup by checking if the latest telemetry entry
// already has the same prompt text.
const TELEMETRY_PATH = path.join(os.homedir(), ".gemini", "antigravity-cli", "telemetry.json");
function alreadyLogged(prompt) {
  try {
    const arr = JSON.parse(fs.readFileSync(TELEMETRY_PATH, "utf8"));
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
            } else if (!prevUserPrompt && text !== lastUserPrompt) {
              prevUserPrompt = text;
              break;
            }
          }
        } catch { /* skip unparseable line */ }
      }

      if (lastUserPrompt && !alreadyLogged(lastUserPrompt)) {
        const skills = scanSkills();
        const cfg = loadConfig();
        const result = await queryJevRouter(lastUserPrompt, skills, cfg, undefined, prevUserPrompt);

        const tokensSaved = (skills.length - result.matchedSkills.length) * 60;
        saveTelemetry({
          id: `ide-${Date.now()}`,
          timestamp: Date.now(),
          prompt: lastUserPrompt,
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

main();
