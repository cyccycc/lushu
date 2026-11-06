import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadRootEnv() {
  const file = path.resolve(process.cwd(), "../..", ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  // Cache Components prerenders a static shell. In this dev environment that
  // shell never resumed, so client components stayed inert. Sessions are
  // request-time data, so keep rendering dynamic.
  cacheComponents: false,
  partialPrefetching: false,
  // The dev server listens on 0.0.0.0; browsers open it as 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@lushu/agent", "@lushu/llm", "@lushu/tools"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
