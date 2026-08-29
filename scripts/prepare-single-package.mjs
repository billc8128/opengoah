import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { restoreSinglePackageState } from "./single-package-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli");
const dist = join(cli, "dist");
const modules = join(cli, "node_modules");
const workspaces = ["ledger-contract", "ledger-sqlite", "runner-pi", "supervisor", "testkit"];
const workspacePackages = new Map();
const entries = ["index", "cli", "kernel", "transcript", "execution", "sqlite", "supervisor", "runner-pi", "testkit"];
const workers = [
  { pkg: "goah-runner-pi", file: "pi-worker" },
  { pkg: "goah-runner-pi", file: "verification-worker" },
  { pkg: "goah-testkit", file: "faux-runner-worker" },
];
const internalPackages = new Set(["@goah/cli", "goah-ledger-contract", "goah-ledger-sqlite", "goah-runner-pi", "goah-supervisor", "goah-testkit"]);
const licenseOverrides = new Map([
  ["@earendil-works/pi-agent-core", join(root, "scripts", "third-party-licenses", "earendil-works-pi.txt")],
  ["@earendil-works/pi-ai", join(root, "scripts", "third-party-licenses", "earendil-works-pi.txt")],
  ["@earendil-works/pi-telemetry", join(root, "scripts", "third-party-licenses", "earendil-works-pi.txt")],
  ["@earendil-works/pi-tui", join(root, "scripts", "third-party-licenses", "earendil-works-pi.txt")],
  ["data-uri-to-buffer", join(root, "scripts", "third-party-licenses", "data-uri-to-buffer.txt")],
]);

// Recover an interrupted earlier pack before touching the current build.
restoreSinglePackageState(root);

const originalDist = join(modules, ".dist-original");
const stagedBundle = join(modules, ".bundle-stage");
try {
  // Stage internal workspace builds so both JS and declaration bundlers resolve
  // their published names. Any partial staging is cleaned by the catch path.
  mkdirSync(modules, { recursive: true });
  for (const workspace of workspaces) {
    const source = join(root, "packages", workspace);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    workspacePackages.set(manifest.name, join(modules, manifest.name, "dist"));
    const target = join(modules, manifest.name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
    writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // Validate every input before moving dist so a bad build cannot strand the workspace.
  if (!existsSync(dist)) throw new Error("missing dist/; run the root build first");
  for (const entry of entries) {
    for (const extension of ["js", "d.ts"]) {
      if (!existsSync(join(dist, `${entry}.${extension}`))) throw new Error(`missing tsc output for entry: dist/${entry}.${extension}; run the root build first`);
    }
  }
  for (const { pkg, file } of workers) {
    if (!existsSync(join(modules, pkg, "dist", `${file}.js`))) throw new Error(`missing tsc output for worker: ${pkg}/dist/${file}.js; run the root build first`);
  }
  if (!existsSync(join(dist, "console"))) throw new Error("missing dist/console; run the root build first");
  if (!existsSync(join(dist, "console", "goah-orbital-mark.png"))) throw new Error("missing terminal logo asset; run the root build first");

  // Snapshot the pristine tsc output. postpack restores it, and the catch path
  // restores it immediately if any publication preparation fails.
  renameSync(dist, originalDist);
  rmSync(stagedBundle, { recursive: true, force: true });

  const result = await build({
    entryPoints: [
      ...entries.map((name) => ({ in: join(originalDist, `${name}.js`), out: name })),
      ...workers.map(({ pkg, file }) => ({ in: join(modules, pkg, "dist", `${file}.js`), out: file })),
    ],
    outdir: stagedBundle,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: false,
    minify: false,
    legalComments: "eof",
    logLevel: "warning",
    metafile: true,
    banner: {
      // Bundled CommonJS dependencies still call require() for Node builtins.
      js: `import { createRequire as __goahCreateRequire } from "node:module";\nconst require = __goahCreateRequire(import.meta.url);`,
    },
  });

  await bundleDeclarations(originalDist, stagedBundle);
  cpSync(join(originalDist, "console"), join(stagedBundle, "console"), { recursive: true });
  cpSync(join(root,"LICENSE"),join(stagedBundle,"LICENSE"));
  writeFileSync(join(stagedBundle, "THIRD-PARTY-NOTICES.md"), thirdPartyNotices(result.metafile));

  renameSync(stagedBundle, dist);
  chmodSync(join(dist, "cli.js"), 0o755);

  const manifestPath = join(cli, "package.json");
  writeFileSync(join(modules, ".publish-manifest.json"), readFileSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.dependencies;
  delete manifest.bundledDependencies;
  delete manifest.bundleDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  restoreSinglePackageState(root);
  throw error;
}

async function bundleDeclarations(fromDir, toDir) {
  for (const entry of entries) {
    if (entry === "cli") {
      writeFileSync(join(toDir, "cli.d.ts"), "export {};\n");
      continue;
    }
    const bundle = await rollup({
      input: join(fromDir, `${entry}.d.ts`),
      external: (id) => id.startsWith("node:"),
      plugins: [internalDeclarationResolver(), dts({ respectExternal: false })],
    });
    await bundle.write({ file: join(toDir, `${entry}.d.ts`), format: "es" });
    await bundle.close();
  }
}

function internalDeclarationResolver() {
  return {
    name: "goah-internal-declarations",
    resolveId(source, importer) {
      if (importer && source.startsWith(".")) {
        const base = resolve(dirname(importer), source);
        const declaration = source.endsWith(".d.ts") ? base
          : source.endsWith(".ts") ? base.replace(/\.ts$/, ".d.ts")
          : source.endsWith(".js") ? base.replace(/\.js$/, ".d.ts")
          : source.endsWith(".mjs") ? base.replace(/\.mjs$/, ".d.mts")
          : source.endsWith(".cjs") ? base.replace(/\.cjs$/, ".d.cts")
          : null;
        if (declaration && existsSync(declaration)) return declaration;
      }
      for (const [name, packageDist] of workspacePackages) {
        if (source === name) return join(packageDist, "index.d.ts");
        if (source.startsWith(`${name}/`)) return join(packageDist, `${source.slice(name.length + 1)}.d.ts`);
      }
      if (!source.startsWith(".") && !source.startsWith("node:")) return packageDeclaration(source);
      return null;
    },
  };
}

function packageDeclaration(source) {
  const parts = source.split("/");
  const packageName = source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = parts.slice(source.startsWith("@") ? 2 : 1).join("/");
  const packageDir = join(root, "node_modules", packageName);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let target = subpath ? manifest.exports?.[`./${subpath}`] : manifest.types ?? manifest.typings ?? manifest.exports?.["."];
  if (target && typeof target === "object") target = target.types ?? target.import ?? target.default;
  if (typeof target !== "string") return null;
  const candidate = join(packageDir, target.replace("*", subpath));
  return [candidate, candidate.replace(/\.(mjs|js)$/, ".d.ts"), candidate.replace(/\.mjs$/, ".d.mts")].find(existsSync) ?? null;
}

function thirdPartyNotices(metafile) {
  const packages = new Map();
  for (const key of Object.keys(metafile.inputs)) {
    const entry = packageForInput(key);
    if (entry && !internalPackages.has(entry.manifest.name)) packages.set(`${entry.manifest.name}@${entry.manifest.version}`, entry);
  }
  const lines = [
    "# Third-party notices",
    "",
    "This distribution bundles code from the following third-party packages under their own license terms:",
    "",
  ];
  for (const key of [...packages.keys()].sort()) {
    const { dir, manifest } = packages.get(key);
    if (typeof manifest.license !== "string" || !manifest.license.trim()) throw new Error(`third-party package ${key} has no declared license`);
    lines.push(`## ${key} — ${manifest.license}`, "");
    lines.push(readLicenseText(manifest.name, dir), "");
  }
  return `${lines.join("\n")}\n`;
}

function packageForInput(input) {
  const normalized = input.replaceAll("\\", "/");
  if (!normalized.split("/").includes("node_modules")) return null;
  let current = dirname(resolve(root, input));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name === "string" && typeof manifest.version === "string") return { dir: current, manifest };
    }
    current = dirname(current);
  }
  return null;
}

function readLicenseText(name, dir) {
  const override = licenseOverrides.get(name);
  if (override) return readFileSync(override, "utf8").trim();
  const licenseName = readdirSync(dir, { withFileTypes: true }).find((item) => item.isFile() && /^(licen[cs]e|copying)(?:$|[-._])/i.test(item.name))?.name;
  if (!licenseName) throw new Error(`third-party package ${name} does not ship a license text and has no override`);
  return readFileSync(join(dir, licenseName), "utf8").trim();
}
