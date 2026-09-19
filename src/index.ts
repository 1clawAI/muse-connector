#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createOneclawPort } from "./oneclaw.js";

function required(name: string): string {
    const v = process.env[name];
    if (!v) {
        console.error(`[muse-connector] ${name} is required`);
        process.exit(2);
    }
    return v;
}

const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.MUSE_CONNECTOR_PUBLIC_URL ?? "https://muse.1claw.co").replace(/\/$/, "");
const dashboardUrl = (process.env.ONECLAW_DASHBOARD_URL ?? "https://1claw.co").replace(/\/$/, "");

const app = createApp(
    {
        connectorSecret: required("MUSE_CONNECTOR_SECRET"),
        publicUrl,
        dashboardUrl,
        linkOrigins: (process.env.MUSE_CONNECTOR_LINK_ORIGINS ?? "https://1claw.co,https://www.1claw.co,https://1claw.xyz,https://www.1claw.xyz").split(",").map((s) => s.trim()),
    },
    createOneclawPort({
        baseUrl: (process.env.ONECLAW_BASE_URL ?? "https://api.1claw.co").replace(/\/$/, ""),
        platformApiKey: required("ONECLAW_PLATFORM_API_KEY"),
        platformAppId: required("ONECLAW_PLATFORM_APP_ID"),
    }),
);

serve({ fetch: app.fetch, port }, () => {
    console.log(`[muse-connector] listening on :${port} (${publicUrl})`);
});
