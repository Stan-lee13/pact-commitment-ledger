import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".worker-build", "pact-demo-storage");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const modules = [
  [path.join(root, "cloudflare", "worker.mjs"), path.join(output, "worker.mjs")],
  [path.join(root, "public", "domain.mjs"), path.join(output, "domain.mjs")],
  [path.join(root, "src", "demo-data.mjs"), path.join(output, "demo-data.mjs")]
];
for (const [source, target] of modules) {
  const contents = await readFile(source);
  await writeFile(target, contents, { mode: 0o600 });
}
const expectedImports = await readFile(path.join(output, "worker.mjs"), "utf8");
if (!expectedImports.includes('from "./domain.mjs"') || !expectedImports.includes('from "./demo-data.mjs"')) {
  throw new Error("Cloudflare Worker module imports do not match the upload package.");
}
console.log(`Packaged ${modules.length} Worker modules at ${output}`);
