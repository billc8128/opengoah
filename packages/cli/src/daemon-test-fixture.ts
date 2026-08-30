import { writeFileSync } from "node:fs";

const path=process.argv.at(-1)!;
writeFileSync(path,String(process.pid));
process.on("SIGTERM",()=>process.exit(0));
setInterval(()=>undefined,1_000);
