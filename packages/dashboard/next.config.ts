import type { NextConfig } from "next"

const nextConfig: NextConfig = {
env: {
    NEXT_PUBLIC_SERVER_URL: process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:4000",
  },
}

export default nextConfig
