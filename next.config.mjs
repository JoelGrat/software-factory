/** @type {import('next').NextConfig} */
const nextConfig = {
  // Treat Supabase packages as server-side externals so they are require()'d
  // directly rather than bundled into a vendor chunk. This prevents the
  // "Cannot find module './vendor-chunks/@supabase.js'" crash that occurs when
  // Next.js HMR rebuilds vendor chunks while a long-running execution API
  // route is still in flight.
  serverExternalPackages: ['@supabase/supabase-js', '@supabase/ssr'],
};

export default nextConfig;
