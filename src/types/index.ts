// ──────────────────────────────────────────────────────────────────────────────
// Tipos compartidos — SkonditBeats API
// ──────────────────────────────────────────────────────────────────────────────

export type UserRole = 'ADMIN' | 'CLIENTE';

export const ROLES_VALIDOS: UserRole[] = ['ADMIN', 'CLIENTE'];

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

export const ADMIN_ROLES: UserRole[] = ['ADMIN'];

export function isAdminRole(rol: string): boolean {
  return rol === 'ADMIN';
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
