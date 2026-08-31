// Guards against README contract-version drift.
//
// README must not hardcode "Contracts are X.Y.Z". If the pattern appears,
// it must equal CONTRACT_VERSION exported by packages/ledger-contract.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kernelSource = readFileSync(
  join(root, "packages/ledger-contract/src/kernel.ts"),
  "utf8",
);
const readme = readFileSync(join(root, "README.md"), "utf8");

const kernelMatch = kernelSource.match(/CONTRACT_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
if (!kernelMatch) {
  console.error("Unable to read CONTRACT_VERSION from packages/ledger-contract/src/kernel.ts");
  process.exit(1);
}
const contractVersion = kernelMatch[1];

const readmeMatch = readme.match(/Contracts are\s+`?(\d+\.\d+\.\d+)`?/);
if (!readmeMatch) {
  console.log(`OK: README does not hardcode a contract version (kernel CONTRACT_VERSION is ${contractVersion}).`);
  process.exit(0);
}

console.error(
  `README hardcodes "Contracts are ${readmeMatch[1]}" but CONTRACT_VERSION is ${contractVersion}. ` +
    "Remove the hardcoded version from README; it is defined by the CONTRACT_VERSION export of goah-ledger-contract.",
);
process.exit(1);
