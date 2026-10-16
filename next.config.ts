import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prompts are read from disk at runtime; include them in the server bundle trace.
  outputFileTracingIncludes: { "/api/chat": ["./prompts/**/*"] },
};

export default nextConfig;
