import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreSinglePackageState } from "./single-package-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
restoreSinglePackageState(root);
