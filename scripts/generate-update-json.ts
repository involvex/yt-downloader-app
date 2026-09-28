import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const TARGET = "x86_64-pc-windows-msvc";
const OWNER = "involvex";
const REPO = "yt-downloader-app";
const TRIPLE = TARGET;

interface Artifact {
  name: string;
  sig: string | null;
}

function findArtifacts(dir: string): Artifact[] {
  if (!existsSync(dir)) return [];
  const results: Artifact[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".exe") && !entry.name.endsWith(".sig")) {
        const sigPath = `${p}.sig`;
        results.push({
          name: entry.name,
          sig: existsSync(sigPath) ? readFileSync(sigPath, "utf-8").trim() : null,
        });
      }
    }
  };
  walk(dir);
  return results;
}

function main() {
  const repoRoot = dirname(dirname(import.meta.url.replace("file:///", "")));
  const cargoTargetDir = process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target");
  const bundleDir = join(cargoTargetDir, "release", "bundle");

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const version: string = pkg.version;

  const artifacts = findArtifacts(bundleDir);
  if (artifacts.length === 0) {
    console.error("No installer artifacts found in", bundleDir);
    process.exit(1);
  }

  const platforms: Record<string, { url: string; signature: string }> = {};
  for (const a of artifacts) {
    platforms[TRIPLE] = {
      url: `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${a.name}`,
      signature: a.sig ?? "",
    };
  }

  const updateJson = {
    version,
    notes: "",
    pub_date: new Date().toISOString(),
    platforms,
  };

  const outPath = join(bundleDir, "update.json");
  writeFileSync(outPath, JSON.stringify(updateJson, null, 2) + "\n", "utf-8");
  console.log("Wrote", outPath);
}

main();
