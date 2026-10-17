/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output keeps the Docker runtime image small, but its trace
  // step needs symlink privileges that Windows withholds outside developer
  // mode. The Dockerfile sets NEXT_OUTPUT=standalone; local builds skip it.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Shared package ships as TS-compiled ESM in the workspace.
  transpilePackages: ["@archive/shared"],
  images: {
    // Every archive image is already a tuned WebP from the images service, so
    // re-optimising it on the Next server would only burn homeserver CPU.
    unoptimized: true,
  },
  experimental: {
    optimizePackageImports: [],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "x-frame-options", value: "DENY" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
