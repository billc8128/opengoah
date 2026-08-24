import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface UpdatePlan { command: string; args: string[]; mode: "global" | "prefix"; prefix: string }

export function packageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }
export function installedVersion(root = packageRoot()): string { return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version; }

export function planNpmUpdate(root: string, globalPrefix: string, target: string, npm = process.platform === "win32" ? "npm.cmd" : "npm"): UpdatePlan {
  const installed = realpathSync(root);
  const globalRoots = process.platform === "win32" ? [join(globalPrefix, "node_modules")] : [join(globalPrefix, "lib", "node_modules"), join(globalPrefix, "node_modules")];
  if (globalRoots.some((directory) => isInside(installed, directory))) return { command: npm, args: ["install", "--global", `@goah/cli@${target}`], mode: "global", prefix: globalPrefix };
  const marker = `${sep}node_modules${sep}@goah${sep}cli`;
  const index = installed.lastIndexOf(marker);
  if (index < 0) throw new Error("This Goah is running from a source checkout. Build or install @goah/cli instead of self-updating the checkout.");
  const prefix = installed.slice(0, index);
  return { command: npm, args: ["install", "--prefix", prefix, `@goah/cli@${target}`], mode: "prefix", prefix };
}

export async function runUpdate(options: { check?: boolean; dryRun?: boolean; target?: string } = {}): Promise<void> {
  const current = installedVersion();
  const target: string = options.target !== undefined ? options.target : await capture("npm", ["view", "@goah/cli", "version", "--json"]).then((text) => String(JSON.parse(text)));
  if (current === target) { console.log(`Goah ${current} is already up to date.`); return; }
  const globalPrefix = (await capture("npm", ["prefix", "--global"])).trim();
  const plan = planNpmUpdate(packageRoot(), globalPrefix, target);
  console.log(`Goah ${current} → ${target}`);
  if (options.check) return;
  console.log(`${options.dryRun ? "Would run" : "Running"}: ${plan.command} ${plan.args.join(" ")}`);
  if (options.dryRun) return;
  await inherit(plan.command, plan.args);
  const updated = installedVersion();
  if (updated !== target) throw new Error(`npm completed but the active installation reports ${updated}, expected ${target}`);
  console.log(`Updated Goah to ${updated}. Restart goah to use the new version.`);
}

function isInside(path: string, directory: string): boolean { const prefix = resolve(directory); return path === prefix || path.startsWith(`${prefix}${sep}`); }
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
  });
}
function inherit(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  });
}
