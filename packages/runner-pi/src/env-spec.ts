/**
 * Spawn-time credential resolution.
 *
 * Config files hold only `env:NAME` references — never secrets. Values are
 * resolved when a child process is spawned, so credential rotation (a changed
 * shell export on a fresh attach, or an edited `.env` file) takes effect on the
 * next wake without restarting the resident Supervisor.
 *
 * Resolution order, first match wins:
 *   1. the supervisor process environment
 *   2. `<workspace>/.env`
 *   3. `~/.goah/.env`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EnvSpecSource {
  /** Absolute path of the workspace root whose `.env` is consulted. */
  root: string;
}

export const ENV_REFERENCE_PREFIX = "env:";

/** Parse one `.env` file into key/value pairs; missing files yield {}. Minimal grammar: KEY=VALUE, quotes stripped, comments and blanks ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function readEnvFile(path: string): Record<string, string> {
  try { return parseEnvFile(readFileSync(path, "utf8")); } catch { return {}; }
}

export function envFileChain(source: EnvSpecSource | undefined): Array<Record<string, string>> {
  if (!source) return [];
  const files = [join(source.root, ".env"), join(homedir(), ".goah", ".env")];
  // First match wins: earlier files in the chain shadow later ones.
  const merged: Record<string, string> = {};
  for (let index = files.length - 1; index >= 0; index -= 1) Object.assign(merged, readEnvFile(files[index]!));
  return [merged];
}

/**
 * Resolve an env spec for one spawn. Literal values pass through; `env:NAME`
 * references consult the chain above. An unresolvable reference throws with the
 * variable name so the wake fails honestly instead of spawning a child that
 * would fail opaquely at its first model call.
 */
export function resolveEnvSpec(spec: Record<string, string> | undefined, source: EnvSpecSource | undefined): Record<string, string> {
  if (!spec) return {};
  const [fileLayer] = envFileChain(source);
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (!value.startsWith(ENV_REFERENCE_PREFIX)) { resolved[key] = value; continue; }
    const name = value.slice(ENV_REFERENCE_PREFIX.length);
    const fromProcess = process.env[name];
    if (fromProcess !== undefined) { resolved[key] = fromProcess; continue; }
    const fromFile = fileLayer?.[name];
    if (fromFile !== undefined) { resolved[key] = fromFile; continue; }
    throw new Error(`environment variable is missing: ${name} (set it in your shell, <workspace>/.env, or ~/.goah/.env)`);
  }
  return resolved;
}
