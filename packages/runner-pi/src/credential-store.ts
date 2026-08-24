import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Small file-backed implementation of Pi's credential contract. */
export class JsonCredentialStore implements CredentialStore {
  readonly #tails = new Map<string, Promise<unknown>>();
  constructor(readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> { return (await this.#readAll())[providerId]; }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#readAll()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    let result: Credential | undefined;
    const next = previous.then(async () => {
      const all = await this.#readAll();
      result = await fn(all[providerId]);
      if (result !== undefined) { all[providerId] = result; await this.#writeAll(all); }
    });
    this.#tails.set(providerId, next);
    try { await next; } finally { if (this.#tails.get(providerId) === next) this.#tails.delete(providerId); }
    return result;
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const all = await this.#readAll();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.#writeAll(all);
    });
    this.#tails.set(providerId, next);
    try { await next; } finally { if (this.#tails.get(providerId) === next) this.#tails.delete(providerId); }
  }

  async #readAll(): Promise<Record<string, Credential>> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as Record<string, Credential>; }
    catch { return {}; }
  }

  async #writeAll(value: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}
