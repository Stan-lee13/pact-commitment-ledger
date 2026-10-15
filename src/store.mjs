import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSeedState } from "./demo-data.mjs";

export class FileStore {
  #filePath;
  #queue = Promise.resolve();

  constructor(filePath = process.env.PACT_DATA_FILE || path.resolve("data/store.json")) {
    this.#filePath = path.resolve(filePath);
  }

  async init() {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#write(createSeedState());
    }
    return this;
  }

  async snapshot() {
    const text = await readFile(this.#filePath, "utf8");
    return JSON.parse(text);
  }

  transact(mutator) {
    const operation = this.#queue.then(async () => {
      const current = await this.snapshot();
      const draft = structuredClone(current);
      const result = await mutator(draft);
      await this.#write(draft);
      return result === undefined ? structuredClone(draft) : structuredClone(result);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #write(state) {
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.#filePath);
  }
}
