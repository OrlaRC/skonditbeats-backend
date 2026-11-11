// Restablece la contraseña de un usuario (solo para desarrollo).
//
// Las contraseñas se guardan con bcrypt (hash de un solo sentido): no se
// pueden leer ni "desencriptar", solo reemplazar por una nueva.
//
// Uso (desde la carpeta api):
//   node --env-file=.env scripts/reset-password.mjs                         -> lista usuarios
//   node --env-file=.env scripts/reset-password.mjs correo@x.com NuevaClave1!  -> cambia la contraseña

import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const [email, password] = process.argv.slice(2);

if (!email) {
  const { data, error } = await supabase
    .from('users')
    .select('email, nombre, rol, activo')
    .order('rol');
  if (error) throw error;
  console.table(data);
  process.exit(0);
}

// Misma política que src/plugins/password.ts
const reglas = [
  [password?.length >= 10, 'mínimo 10 caracteres'],
  [/[A-Z]/.test(password ?? ''), 'una mayúscula'],
  [/[a-z]/.test(password ?? ''), 'una minúscula'],
  [/\d/.test(password ?? ''), 'un número'],
  [/[^A-Za-z0-9]/.test(password ?? ''), 'un carácter especial'],
];
const faltan = reglas.filter(([ok]) => !ok).map(([, msg]) => msg);
if (faltan.length) {
  console.error(`La contraseña no cumple la política. Falta: ${faltan.join(', ')}`);
  process.exit(1);
}

const { data, error } = await supabase
  .from('users')
  .update({
    password: await bcrypt.hash(password, 12),
    intentos_fallidos: 0,
    bloqueado_hasta: null,
  })
  .eq('email', email.toLowerCase().trim())
  .select('email, nombre, rol');

if (error) throw error;
if (!data.length) {
  console.error(`No existe un usuario con el correo ${email}`);
  process.exit(1);
}
console.log(`Contraseña actualizada para ${data[0].nombre} (${data[0].email}, ${data[0].rol})`);
