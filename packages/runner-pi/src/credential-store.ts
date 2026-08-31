import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CredentialStore as UpstreamCredentialStore } from "@earendil-works/pi-ai";

export type PiCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | ({ type: "oauth"; refresh: string; access: string; expires: number } & Record<string, unknown>);
export interface PiCredentialInfo {
  providerId: string;
  type: PiCredential["type"];
}

/** Small file-backed implementation of Pi's credential contract. */
export class JsonCredentialStore {
  #tail: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  async read(providerId: string): Promise<PiCredential | undefined> {
    return (await this.#readAll())[providerId];
  }
  async list(): Promise<readonly PiCredentialInfo[]> {
    return Object.entries(await this.#readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
  ): Promise<PiCredential | undefined> {
    return this.#enqueue(async () => {
      const all = await this.#readAll();
      const result = await fn(all[providerId]);
      if (result !== undefined) {
        all[providerId] = result;
        await this.#writeAll(all);
      }
      return result;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.#enqueue(async () => {
      const all = await this.#readAll();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.#writeAll(all);
    });
  }

  async replaceFileIfUnchanged(expected: Buffer | null, next: Buffer | null): Promise<void> {
    await this.#enqueue(async () => {
      const current = await this.#readRaw();
      if (!buffersEqual(current, expected))
        throw new Error(
          "Credentials changed in another process during setup; retry to avoid overwriting them.",
        );
      if (next === null) await rm(this.path, { force: true });
      else {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.replace.tmp`;
        await writeFile(temporary, next, { mode: 0o600 });
        await rename(temporary, this.path);
        await chmod(this.path, 0o600);
      }
    });
  }

  async replaceProviderIfUnchanged(
    providerId: string,
    expected: PiCredential | undefined,
    next: PiCredential | undefined,
  ): Promise<void> {
    await this.#enqueue(async () => {
      const all = await this.#readAll();
      if (!sameCredential(all[providerId], expected))
        throw new Error(
          `Credentials for ${providerId} changed in another process; refusing to overwrite them.`,
        );
      if (next === undefined) delete all[providerId];
      else all[providerId] = next;
      await this.#writeAll(all);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => this.#withFileLock(operation));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    const ownerPath = `${lock}/owner.json`;
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    await mkdir(dirname(this.path), { recursive: true });
    while (true) {
      let acquired = false;
      try {
        await mkdir(lock);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await readLockOwner(ownerPath);
        const info = owner
          ? null
          : await stat(lock).catch((statError: NodeJS.ErrnoException) =>
              statError.code === "ENOENT" ? null : Promise.reject(statError),
            );
        if (!owner && !info) continue;
        if (owner ? !processIsAlive(owner.pid) : Date.now() - info!.mtimeMs > 5_000) {
          const stale = `${lock}.stale.${token}`;
          try {
            await rename(lock, stale);
            await rm(stale, { recursive: true, force: true });
          } catch (reclaimError) {
            if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
          }
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error("Timed out waiting for the credential store lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (acquired) {
        try {
          await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }));
        } catch (error) {
          await rm(lock, { recursive: true, force: true });
          throw error;
        }
        break;
      }
    }
    try {
      return await operation();
    } finally {
      if ((await readLockOwner(ownerPath))?.token === token)
        await rm(lock, { recursive: true, force: true });
    }
  }

  async #readAll(): Promise<Record<string, PiCredential>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, PiCredential>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async #readRaw(): Promise<Buffer | null> {
    return readFile(this.path).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
  }

  async #writeAll(value: Record<string, PiCredential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}
function sameCredential(left: PiCredential | undefined, right: PiCredential | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
async function readLockOwner(path: string): Promise<{ pid: number; token: string } | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; token?: unknown };
    return Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string"
      ? (value as { pid: number; token: string })
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const credentialStoreContract: new (path: string) => UpstreamCredentialStore = JsonCredentialStore;
void credentialStoreContract;
