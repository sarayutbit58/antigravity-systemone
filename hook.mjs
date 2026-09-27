#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { scanSkills, queryJevRouter, loadConfig, loadEnv } from "./index.mjs";
import { saveTelemetry } from "./dashboard.mjs";

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

      // Find the most recent USER_INPUT line
      let lastUserPrompt = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const step = JSON.parse(lines[i]);
          if (step.type === "USER_INPUT" && step.content) {
            const raw = step.content;
            // Extract from <USER_REQUEST> if present
            const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            lastUserPrompt = (m ? m[1] : raw).trim();
            break;
          }
        } catch { /* skip unparseable line */ }
      }

      if (lastUserPrompt) {
        const skills = scanSkills();
        const cfg = loadConfig();
        const result = await queryJevRouter(lastUserPrompt, skills, cfg);

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
