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

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

mkdirSync(OUTPUT, { recursive: true });

const files = collectBlockCloneFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude ?? [],
});

const tokenized = files.map((filePath) => {
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
});

const artifact = assembleBlockCloneArtifact({
  root: ROOT,
  files: tokenized,
  includeTests: cli.includeTests,
  exclude: cli.exclude ?? [],
  generated: producerMetaBase({
    tool: "build-block-clone-index.mjs",
    root: ROOT,
  }).generated,
});

const outPath = path.join(OUTPUT, "block-clones.json");
writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");

console.log(
  `[block-clones] ${artifact.summary.fileCount} files, ` +
    `${artifact.summary.groupCount} review groups, status=${artifact.status}`,
);
console.log(`[block-clones] saved -> ${outPath}`);
