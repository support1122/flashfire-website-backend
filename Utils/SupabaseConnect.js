// utils/supabaseClient.ts or similar
import { createClient } from '@supabase/supabase-js';

export const SupabaseConnect = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLIC_SECRET_SERVICE_KEY_FOR_BACKEND 
);

