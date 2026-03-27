import { createClient } from '@supabase/supabase-js'

// Service-role client for server-side async jobs (not tied to request cookies)
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
