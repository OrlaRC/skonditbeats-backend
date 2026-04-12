import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env['SUPABASE_URL'];
const supabaseKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Faltan variables de entorno: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorias'
  );
}

// service_role bypasea RLS — solo usar en el backend, nunca en el frontend
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
