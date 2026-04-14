/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable server-side chunk splitting in development so there are no
  // vendor chunks that can be evicted by HMR while a long-running execution
  // API route is still in flight. Without this, Next.js rebuilds vendor
  // chunks mid-execution and the in-flight request crashes with
  // "Cannot find module './vendor-chunks/@supabase.js'" (or similar).
  webpack: (config, { isServer, dev }) => {
    if (isServer && dev) {
      config.optimization.splitChunks = false
    }
    return config
  },
};

export default nextConfig;
