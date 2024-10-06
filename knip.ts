import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignore: ["dist/**"],
  ignoreDependencies: [
    // Used in eslint.config.mjs
    "eslint-plugin-github",
    "eslint-plugin-import",
    // Required by eslint-plugin-import-x
    "@typescript-eslint/parser",
    "eslint-import-resolver-typescript",
  ],
};

export default config;
