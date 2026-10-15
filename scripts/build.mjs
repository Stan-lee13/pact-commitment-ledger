import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedState } from "../src/demo-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "public"), output, { recursive: true });
await writeFile(path.join(output, "demo-state.json"), `${JSON.stringify(createSeedState(), null, 2)}\n`, { mode: 0o644 });
const indexPath = path.join(output, "index.html");
const indexHtml = await readFile(indexPath, "utf8");
const marker = '<meta name="pact-public-demo" content="true">';
const builtIndex = indexHtml.includes(marker)
  ? indexHtml
  : indexHtml.replace('<meta name="theme-color" content="#173d34">', `<meta name="theme-color" content="#173d34">\n  ${marker}`);
if (!builtIndex.includes(marker)) throw new Error("Could not mark the static output as a public demo.");
await writeFile(indexPath, builtIndex, "utf8");

const forbidden = ["server.mjs", "src", "data/store.json", ".env"];
for (const entry of forbidden) {
  try {
    await readFile(path.join(output, entry));
    throw new Error(`Unexpected private/server file copied into static output: ${entry}`);
  } catch (error) {
    if (error.code !== "ENOENT" && !String(error.message).startsWith("Unexpected private/server file")) throw error;
    if (String(error.message).startsWith("Unexpected private/server file")) throw error;
  }
}

console.log(`Built safe static demo at ${output}`);
