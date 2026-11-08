import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryStore, type ActionRecord } from "./store.ts";

/** Node store that keeps records in a JSON file (good for one server; use a database to scale out). */
export class FileStore extends MemoryStore {
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      for (const r of JSON.parse(readFileSync(file, "utf8")) as ActionRecord[]) this.records.set(r.id, r);
    }
  }

  override async put(rec: ActionRecord) {
    await super.put(rec);
    const snapshot = JSON.stringify([...this.records.values()], null, 1);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot);
    });
    await this.writing;
  }
}
