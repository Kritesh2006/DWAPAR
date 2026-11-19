import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// End-to-end tests run against a real DWAPAR engine serving the built dashboard.
const PORT = 8099;
const db = path.join(os.tmpdir(), `dwapar-e2e-${process.pid}.sqlite`);
const python = process.env.PYTHON ?? "python3";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 950 },
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `${python} -m dwapar serve --db ${db} --size 48 --seed 11 --speed 6 --port ${PORT} --static ../dashboard/dist`,
    cwd: "../engine",
    url: `http://127.0.0.1:${PORT}/api/status`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
