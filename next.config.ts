import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static reports the path of a binary next to its own files. Bundling
  // it would rewrite that path, so it has to stay a real require at runtime.
  serverExternalPackages: ["ffmpeg-static"],

  // Vercel only uploads files it can see being used. The ffmpeg binary is
  // reached through a variable and the font is only ever named in a string, so
  // both have to be listed explicitly.
  outputFileTracingIncludes: {
    "/api/generate": ["./node_modules/ffmpeg-static/**", "./assets/fonts/**"],
  },
};

export default nextConfig;
