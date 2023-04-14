import { esbuildPlugin } from "@web/dev-server-esbuild";
import { puppeteerLauncher } from "@web/test-runner-puppeteer";

export default {
  files: "src/**/*.spec.ts",
  coverage: true,
  watch: false,
  nodeResolve: true,
  // something wrong with a test? try uncommenting these for easier debugging
  // debug: true,
  // open: true,
  // manual: true,
  plugins: [
    esbuildPlugin({
      ts: true,
      target: "auto",
      tsconfig: "./tsconfig.spec.json",
    }),
  ],
  browsers: [
    puppeteerLauncher({
      launchOptions: {
        // something wrong with a test? try toggling these for easier debugging
        headless: true,
        devtools: false,
      },
    }),
  ],
};
