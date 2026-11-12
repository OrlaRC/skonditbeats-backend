/**
 * Fragmentos de esquema JSON que comparten varias rutas.
 *
 * Correo: antes cada ruta lo declaraba solo como { type: 'string' }, así que la API
 * aceptaba "nope" o "" como correo si la petición no venía de la app (Postman, curl).
 * La app ya lo validaba; ahora el servidor también (Práctica 11, DEF-10).
 * Mismo criterio que Validators.email de la app: algo@dominio.tld, sin espacios.
 */
export const EMAIL = {
  type: 'string',
  maxLength: 150,
  pattern: '^\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*$',
} as const;
