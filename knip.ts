import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: ["dist/**"],
  ignoreDependencies: [
    // Required by eslint-plugin-import-x
    "eslint-import-resolver-typescript",
  ],
};

export default config;
