// Restablece la contraseña de un usuario (solo para desarrollo).
//
// Las contraseñas se guardan con bcrypt (hash de un solo sentido): no se
// pueden leer ni "desencriptar", solo reemplazar por una nueva.
//
// Uso (desde la carpeta api):
//   node --env-file=.env scripts/reset-password.mjs                         -> lista usuarios
//   node --env-file=.env scripts/reset-password.mjs correo@x.com NuevaClave1!  -> cambia la contraseña

import bcrypt from 'bcryptjs';
import postgres from 'postgres';

const local = /@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? '');
const sql = postgres(process.env.DATABASE_URL, { ssl: local ? false : 'require', prepare: false, max: 1 });
const [email, password] = process.argv.slice(2);

if (!email) {
  console.table(await sql`select email, nombre, rol, activo from users order by rol`);
  await sql.end();
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

const data = await sql`
  update users
  set password = ${await bcrypt.hash(password, 12)}, intentos_fallidos = 0, bloqueado_hasta = null, updated_at = now()
  where email = ${email.toLowerCase().trim()}
  returning email, nombre, rol`;
await sql.end();

if (!data.length) {
  console.error(`No existe un usuario con el correo ${email}`);
  process.exit(1);
}
console.log(`Contraseña actualizada para ${data[0].nombre} (${data[0].email}, ${data[0].rol})`);
