import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Le binaire Chromium des robots (L'Addition, Uber Eats) doit être embarqué dans chaque fonction serveur
  // qui lance le navigateur : sans cela, « /var/task/node_modules/@sparticuz/chromium/bin does not exist ».
  outputFileTracingIncludes: Object.fromEntries(
    [
      "/api/laddition/extraire",
      "/api/laddition/services",
      "/api/cron/laddition",
      "/api/ticket-z",
      "/api/uber-eats/relever",
      "/api/uber-eats/contester",
      "/api/cron/uber",
    ].map((route) => [route, ["./node_modules/@sparticuz/chromium/bin/**"]]),
  ),
  partialPrefetching: true,
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
