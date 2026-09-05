import { mkdir, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { Glob } from "bun";

const targetDir = process.env.CARGO_TARGET_DIR || join("src-tauri", "target");
const bundleDir = join(targetDir, "release", "bundle");
const destDir = "releases";

await mkdir(destDir, { recursive: true });

// Ordner und Suchmuster trennen (verhindert Windows-Backslash-Bugs in Globs)
const targets = [
  { dir: join(bundleDir, "nsis"), pattern: "*.exe" },
  { dir: join(bundleDir, "msi"), pattern: "*.msi" },
];

let copiedCount = 0;

for (const { dir, pattern } of targets) {
  const glob = new Glob(pattern);

  try {
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      const fileName = basename(file);
      const destPath = join(destDir, fileName);

      await copyFile(file, destPath);
      console.log(`[OK] Kopiert: ${fileName} -> ${destPath}`);
      copiedCount++;
    }
  } catch {
    // Falls der nsis- oder msi-Ordner nicht existiert (z. B. wenn nur ein Target gebaut wurde)
  }
}

if (copiedCount === 0) {
  console.warn(`[WARNUNG] Keine Installer-Dateien in ${bundleDir} gefunden!`);
}

// Standalone Binary kopieren
const rawExe = join(targetDir, "release", "downloader-app.exe");
try {
  await copyFile(rawExe, join(destDir, "downloader-app.exe"));
  console.log(`[OK] Standalone Binary kopiert: downloader-app.exe`);
} catch {
  // Ignorieren falls nicht gebaut
}
