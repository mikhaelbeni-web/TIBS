import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Le binaire Chromium du robot L'Addition doit être embarqué dans la fonction serveur.
  outputFileTracingIncludes: {
    "/api/laddition/extraire": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
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
