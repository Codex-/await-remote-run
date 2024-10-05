import { run } from "./await-remote-run.ts";

async function main(): Promise<void> {
  await run();
}

if (!process.env.VITEST) {
  await main();
}
