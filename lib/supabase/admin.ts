import { createClient } from '@supabase/supabase-js'

// Service-role client for server-side async jobs (not tied to request cookies).
// persistSession + autoRefreshToken must be false: without them the client can
// pick up or refresh a user JWT, which overrides the service-role key and causes
// FK constraint failures on RLS-protected tables (FK checks apply the session's
// row-security policies, so a non-service-role session can't see the referenced row).
export function createAdminClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — admin client cannot be created')
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  )
}
