import { createHash } from "node:crypto";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// F1–F6 修复用的浏览器回归配置。
// 直接启动隔离端口的 Next，避免复用本机其他服务。
const port = Number(process.env.VOZEB_PRO_E2E_PORT || 3000);
const baseURL = `http://127.0.0.1:${port}`;
const protocolFixturePort = Number(process.env.VOZEB_PRO_PROTOCOL_FIXTURE_PORT || 4010);
const paymentFixturePort = Number(process.env.VOZEB_PRO_PAYMENT_FIXTURE_PORT || 4020);
const storageState = path.join(process.cwd(), ".e2e-data", "admin-state.json");

export default defineConfig({
    testDir: "./e2e",
    outputDir: ".e2e-artifacts",
    fullyParallel: false,
    timeout: 180_000,
    workers: 1,
    reporter: "list",
    use: {
        baseURL,
        // 本机缓存的 Playwright 浏览器版本与 @playwright/test 1.62.1 不匹配，改用系统安装的 Chrome。
        channel: "chrome",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        permissions: ["clipboard-read", "clipboard-write"],
    },
    projects: [
        { name: "setup", testMatch: /installation\.spec\.ts/ },
        { name: "chromium", testMatch: /canvas-f1f6\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState } },
        // 项目自带的既有 canvas e2e 套件：用于确认本次改动没有破坏既有画布行为。
        { name: "canvas-existing", testMatch: /canvas\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState } },
        { name: "mobile-390", testMatch: /canvas-f1f6-mobile\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 }, storageState } },
        { name: "mobile-430", testMatch: /canvas-f1f6-mobile\.spec\.ts/, dependencies: ["setup"], use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium", viewport: { width: 430, height: 932 }, storageState } },
    ],
    webServer: [
        {
            command: "node scripts/protocol-fixture-server.mjs",
            url: `http://127.0.0.1:${protocolFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, VOZEB_PRO_PROTOCOL_FIXTURE_PORT: String(protocolFixturePort) },
        },
        {
            command: "node scripts/payment-fixture-server.mjs",
            url: `http://127.0.0.1:${paymentFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, VOZEB_PRO_PAYMENT_FIXTURE_PORT: String(paymentFixturePort) },
        },
        {
            command: `node node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p ${port}`,
            url: `${baseURL}/api/auth/session`,
            timeout: 180_000,
            reuseExistingServer: false,
            env: {
                ...process.env,
                NEXT_DIST_DIR: ".next-e2e-review",
                PORT: String(port),
                NEXT_PUBLIC_SITE_URL: baseURL,
                VOZEB_PRO_DATABASE_PROVIDER: "file",
                VOZEB_PRO_DATA_DIR: path.join(process.cwd(), ".e2e-data"),
                VOZEB_PRO_ENCRYPTION_KEY: createHash("sha256").update("vozeb-pro-e2e-canvas-encryption").digest("hex"),
                VOZEB_PRO_INSTALL_TOKEN: "vozeb-pro-e2e-install-token-32chars",
                VOZEB_PRO_MAINTENANCE_TOKEN: "vozeb-pro-e2e-maintenance-token-32chars",
                VOZEB_PRO_WORKER_TOKEN: "vozeb-pro-e2e-worker-token-separate-32chars",
                VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS: "1",
                VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS: "127.0.0.1",
                VOZEB_PRO_PAYPLY_API_KEY: "vozeb-pro-e2e-payply-production-key",
                VOZEB_PRO_PAYPLY_CHECKOUT_URL: `http://127.0.0.1:${paymentFixturePort}/payply/checkout`,
                VOZEB_PRO_PAYPLY_WEBHOOK_SECRET: "vozeb-pro-e2e-payply-webhook-secret",
            },
        },
    ],
});
