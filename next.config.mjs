/** @type {import('next').NextConfig} */
const nextConfig = {
  // Treat Supabase packages as server-side externals so they are require()'d
  // directly rather than bundled into a vendor chunk. This prevents the
  // "Cannot find module './vendor-chunks/@supabase.js'" crash that occurs when
  // Next.js HMR rebuilds vendor chunks while a long-running execution API
  // route is still in flight.
  serverExternalPackages: ['@supabase/supabase-js', '@supabase/ssr'],

  // Use deterministic chunk and module IDs in development so vendor chunk
  // filenames stay stable across HMR rebuilds. Without this, a rebuild
  // renames chunks and any in-flight request that loaded the old name crashes.
  webpack: (config, { dev }) => {
    if (dev) {
      config.optimization.moduleIds = 'deterministic'
      config.optimization.chunkIds = 'deterministic'
    }
    return config
  },
};

export default nextConfig;
