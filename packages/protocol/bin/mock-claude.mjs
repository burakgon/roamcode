#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { env, stdout, exit, stderr } from "node:process";
import { replayFixture } from "../dist/index.js";

const fixturePath = env.MOCK_CLAUDE_FIXTURE;
if (!fixturePath) {
  stderr.write("MOCK_CLAUDE_FIXTURE env var is required\n");
  exit(2);
}
const fixture = readFileSync(fixturePath, "utf8");
const delayMs = env.MOCK_CLAUDE_DELAY_MS ? Number(env.MOCK_CLAUDE_DELAY_MS) : 0;
await replayFixture(fixture, (line) => stdout.write(line + "\n"), { delayMs });
exit(0);
