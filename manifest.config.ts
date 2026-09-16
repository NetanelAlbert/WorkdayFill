import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "WorkdayFill — Attendance Helper for Workday",
  version: pkg.version,
  description:
    "Unofficial tool to auto-fill missing attendance days in Workday's Enter Time calendar. Not affiliated with or endorsed by Workday.",
  permissions: ["storage"],
  host_permissions: ["https://*.myworkday.com/*"],
  action: {
    default_popup: "src/popup/popup.html",
    default_icon: {
      16: "public/images/icon16.png",
      32: "public/images/icon32.png",
      48: "public/images/icon48.png",
      128: "public/images/icon128.png",
    },
  },
  icons: {
    16: "public/images/icon16.png",
    32: "public/images/icon32.png",
    48: "public/images/icon48.png",
    128: "public/images/icon128.png",
  },
  content_scripts: [
    {
      matches: ["https://*.myworkday.com/*"],
      js: ["src/content/content.ts"],
      run_at: "document_idle",
    },
    {
      // MAIN-world helper for the headless engine: captures Workday's calendar-model URL at
      // document_start so the isolated content script can read it (see src/content/main-world.ts).
      matches: ["https://*.myworkday.com/*"],
      js: ["src/content/main-world.ts"],
      run_at: "document_start",
      world: "MAIN",
    },
  ],
  background: {
    service_worker: "src/background.ts",
  },
});
