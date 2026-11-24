// ──────────────────────────────────────────────────────────────────────────────
// Tipos compartidos — SkonditBeats API
// ──────────────────────────────────────────────────────────────────────────────

// Tres roles:
//   CLIENTE      compra y abre tickets.
//   ADMIN        administra catálogo, tickets y clientes.
//   SUPER_ADMIN  todo lo del ADMIN y además gestiona a los administradores
//                (crearlos, cambiarles el rol, la contraseña o desactivarlos).
export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'CLIENTE';

export const ROLES_VALIDOS: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'CLIENTE'];

export const PERMISOS_DISPONIBLES: string[] = [
  'user:view',
  'user:create',
  'user:update',
  'user:delete',
  'user:permissions',
  'user:password',
  'beat:view',
  'beat:create',
  'beat:update',
  'beat:delete',
  'order:view',
  'message:view',
  'audit:view'
];

export const ADMIN_ROLES: UserRole[] = ['SUPER_ADMIN', 'ADMIN'];

/** ADMIN o SUPER_ADMIN: acceso al panel de administración. */
export function isAdminRole(rol: string | null | undefined): boolean {
  return rol === 'ADMIN' || rol === 'SUPER_ADMIN';
}

export function isSuperAdmin(rol: string | null | undefined): boolean {
  return rol === 'SUPER_ADMIN';
}

/**
 * ¿Puede quien tiene el rol `actor` modificar a una cuenta con rol `objetivo`
 * y dejarla con rol `nuevo`? Un ADMIN solo gestiona clientes; tocar o crear
 * administradores es exclusivo del SUPER_ADMIN.
 */
export function puedeGestionar(actor: string, objetivo: string | null, nuevo?: string | null): boolean {
  if (isSuperAdmin(actor)) return true;
  if (!isAdminRole(actor)) return false;
  const tocaAdmin = isAdminRole(objetivo) || isAdminRole(nuevo ?? null);
  return !tocaAdmin;
}

export interface User {
  id: string;
  username?: string;
  email: string;
  nombre: string;
  rol: UserRole;
  permissions: string[];
  foto_url?: string;
  direccion?: string;
  telefono?: string;
  edad?: number;
  activo: boolean;
  fecha_registro: string;
  created_at: string;
  updated_at: string;
}

export interface Beat {
  id: string;
  nombre: string;
  genero: string;
  bpm: number;
  precio: number;
  imagen_url?: string;
  audio_url?: string;
  descripcion?: string;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  user_id: string;
  total: number;
  status: 'PENDIENTE' | 'COMPLETADO' | 'CANCELADO';
  created_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  beat_id: string;
  precio_unitario: number;
}

export interface ContactMessage {
  id: string;
  nombre: string;
  email: string;
  mensaje: string;
  created_at: string;
}

// Payload firmado en el JWT
export interface JwtPayload {
  sub: string;      // user id
  email: string;
  rol: UserRole;
  jti?: string;     // id de la sesión (tabla sesiones)
  iat?: number;
  exp?: number;
}

// Extensión de @fastify/jwt — forma correcta de tipar el payload
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
