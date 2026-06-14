#!/usr/bin/env node
// build-block-clone-index.mjs - repeated block/region review evidence.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { producerMetaBase } from "../lib/artifacts.mjs";
import {
  assembleBlockCloneArtifact,
  collectBlockCloneFiles,
  tokenizeBlockCloneSource,
} from "../lib/block-clone-artifact.mjs";
import { parseCliArgs } from "../lib/cli.mjs";
import { createProducerPhaseTimer } from "../lib/producer-phase-timing.mjs";

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

mkdirSync(OUTPUT, { recursive: true });
const phaseTimer = createProducerPhaseTimer({
  producer: "build-block-clone-index.mjs",
  output: OUTPUT,
});

const files = phaseTimer.runPhase("collect-files", () =>
  collectBlockCloneFiles(ROOT, {
    includeTests: cli.includeTests,
    exclude: cli.exclude ?? [],
  }),
);
phaseTimer.setCounter("filesCollected", files.length);

const tokenized = phaseTimer.runPhase("tokenize-files", () =>
  files.map((filePath) => {
    let src = "";
    try {
      src = readFileSync(filePath, "utf8");
    } catch (error) {
      return {
        relFile: path.relative(ROOT, filePath).replace(/\\/g, "/"),
        tokens: [],
        skipped: null,
        diagnostics: [
          {
            file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
            kind: "read-error",
            message: error?.message ?? String(error),
          },
        ],
      };
    }
    return tokenizeBlockCloneSource({ root: ROOT, filePath, src });
  }),
);
phaseTimer.setCounter("tokenizedFiles", tokenized.length);
phaseTimer.setCounter(
  "tokenCount",
  tokenized.reduce((sum, file) => sum + (file.tokens?.length ?? 0), 0),
);

const artifact = phaseTimer.runPhase("assemble-artifact", () =>
  assembleBlockCloneArtifact({
    root: ROOT,
    files: tokenized,
    includeTests: cli.includeTests,
    exclude: cli.exclude ?? [],
    generated: producerMetaBase({
      tool: "build-block-clone-index.mjs",
      root: ROOT,
    }).generated,
  }),
);
phaseTimer.setCounter("reviewGroupCount", artifact.summary.reviewGroupCount);
phaseTimer.setCounter("mutedGroupCount", artifact.summary.mutedGroupCount);
phaseTimer.setCounter("artifactTokenCount", artifact.summary.tokenCount);

const outPath = path.join(OUTPUT, "block-clones.json");
phaseTimer.runPhase("write-artifact", () => {
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
});
phaseTimer.write();

console.log(
  `[block-clones] ${artifact.summary.fileCount} files, ` +
    `${artifact.summary.reviewGroupCount} review groups, ` +
    `${artifact.summary.mutedGroupCount} muted groups, status=${artifact.status}`,
);
console.log(`[block-clones] saved -> ${outPath}`);
