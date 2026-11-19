import type { FastifyInstance }  from 'fastify';
import bcrypt                    from 'bcryptjs';
import { OAuth2Client }          from 'google-auth-library';
import { sql }                   from '../../db/sql';
import { sendOtpEmail }          from '../../plugins/email';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';
import type { JwtPayload }       from '../../types/index';
import { isAdminRole }           from '../../types/index';
import { EMAIL }                 from '../../schemas/comunes';

/** Inicio de sesión con Google desde la app móvil: vuelve a skonditbeats://login?... */
const ORIGEN_MOVIL  = 'movil';
const REGRESO_MOVIL = 'skonditbeats:/';

const MAX_INTENTOS      = 5;
const TIEMPO_BLOQUEO_MS = 15 * 60 * 1000; // 15 minutos

interface RegisterBody {
  email:      string;
  password:   string;
  nombre:     string;
  username?:  string;
  direccion?: string;
  telefono?:  string;
  edad?:      number;
}

interface LoginBody {
  email:    string;
  password: string;
}

interface VerifyOtpBody {
  email: string;
  code:  string;
}

const googleClient = new OAuth2Client(
  process.env['GOOGLE_CLIENT_ID'],
  process.env['GOOGLE_CLIENT_SECRET'],
  process.env['GOOGLE_CALLBACK_URL']
);

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // ─── POST /api/auth/register ───────────────────────────────────────────────
  app.post<{ Body: RegisterBody }>('/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'nombre'],
        properties: {
          email:     EMAIL,
          password:  { type: 'string', minLength: 10 },
          nombre:    { type: 'string', minLength: 2 },
          username:  { type: 'string' },
          direccion: { type: 'string' },
          telefono:  { type: 'string' },
          edad:      { type: 'number', minimum: 0, maximum: 120 }
        }
      }
    }
  }, async (request, reply) => {
    const { email, password, nombre, username, direccion, telefono, edad } = request.body;

    const errorPolitica = validarPoliticaPassword(password);
    if (errorPolitica) {
      return reply.code(400).send({ error: errorPolitica, politica: DESCRIPCION_POLITICA });
    }

    const [existing] = await sql`select id from users where email = ${email.toLowerCase().trim()}`;

    if (existing) {
      return reply.code(409).send({ error: 'El email ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let user: { id: string; email: string; nombre: string; username: string | null; rol: JwtPayload['rol']; fecha_registro: string };
    try {
      [user] = await sql<typeof user[]>`
        insert into users ${sql({
          email:       email.toLowerCase().trim(),
          password:    passwordHash,
          nombre,
          username:    username?.trim()  || null,
          direccion:   direccion?.trim() || null,
          telefono:    telefono?.trim()  || null,
          edad:        edad ?? null,
          rol:         'CLIENTE',
          permissions: sql.array([])
        })}
        returning id, email, nombre, username, rol, fecha_registro`;
    } catch (error) {
      // Dos registros simultáneos del mismo correo: la restricción UNIQUE decide.
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'El email ya está registrado' });
      }
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al crear el usuario' });
    }

    await registrarAudit(app, {
      user_id: user.id,
      email:   user.email,
      accion:  'ALTA_USUARIO',
      detalle: `Registro de ${user.nombre} (${user.email}) con rol ${user.rol}`,
      ip:      ipDeRequest(request)
    });

    const payload: JwtPayload = {
      sub:   user.id,
      email: user.email,
      rol:   user.rol
    };

    const token = app.jwt.sign(payload);
    return reply.code(201).send({ token, user });
  });


  // ─── POST /api/auth/login ──────────────────────────────────────────────────
  app.post<{ Body: LoginBody }>('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body;
    const emailNormalizado   = email.toLowerCase().trim();

    const [user] = await sql<CuentaLogin[]>`
      select id, email, nombre, username, rol, password, foto_url, activo, intentos_fallidos, bloqueado_hasta
      from users where email = ${emailNormalizado}`;

    if (!user) {
      await registrarAudit(app, {
        user_id: null,
        email:   emailNormalizado,
        accion:  'LOGIN_FALLIDO',
        detalle: 'Intento de inicio de sesión con email no registrado',
        ip:      ipDeRequest(request)
      });
      return reply.code(401).send({ error: 'Credenciales inválidas' });
    }

    // ── Bloqueo temporal ─────────────────────────────────────────────────────
    if (user.bloqueado_hasta && new Date(user.bloqueado_hasta).getTime() > Date.now()) {
      const minutosRestantes = Math.ceil(
        (new Date(user.bloqueado_hasta).getTime() - Date.now()) / 60000
      );
      return reply.code(423).send({
        error: `Cuenta temporalmente bloqueada por demasiados intentos. Intenta en ${minutosRestantes} minuto(s).`
      });
    }

    if (!user.activo) {
      return reply.code(401).send({ error: 'Cuenta desactivada' });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      const nuevosIntentos = (user.intentos_fallidos ?? 0) + 1;
      const update: Record<string, unknown> = { intentos_fallidos: nuevosIntentos };

      if (nuevosIntentos >= MAX_INTENTOS) {
        update.intentos_fallidos = 0;
        update.bloqueado_hasta   = new Date(Date.now() + TIEMPO_BLOQUEO_MS);
      }

      await sql`update users set ${sql(update)} where id = ${user.id}`;

      await registrarAudit(app, {
        user_id: user.id,
        email:   user.email,
        accion:  'LOGIN_FALLIDO',
        detalle: `Contraseña incorrecta (intento ${nuevosIntentos} de ${MAX_INTENTOS})`,
        ip:      ipDeRequest(request)
      });

      if (nuevosIntentos >= MAX_INTENTOS) {
        return reply.code(423).send({
          error: 'Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos.'
        });
      }

      return reply.code(401).send({ error: 'Credenciales inválidas' });
    }

    // Credenciales OK → reiniciar contador si se estaba en 0 por bloqueo expirado
    if ((user.intentos_fallidos ?? 0) > 0) {
      await sql`update users set intentos_fallidos = 0, bloqueado_hasta = null where id = ${user.id}`;
    }

    // Credenciales OK → los administradores entran directo (sin OTP)
    if (isAdminRole(user.rol)) {
      await registrarAudit(app, {
        user_id: user.id,
        email:   user.email,
        accion:  'LOGIN',
        detalle: `Inicio de sesión exitoso (${user.nombre})`,
        ip:      ipDeRequest(request)
      });

      const payloadAdmin: JwtPayload = {
        sub:   user.id,
        email: user.email,
        rol:   user.rol
      };

      return reply.send({
        token: app.jwt.sign(payloadAdmin),
        user:  {
          id:       user.id,
          email:    user.email,
          nombre:   user.nombre,
          username: user.username,
          rol:      user.rol,
          foto_url: user.foto_url
        }
      });
    }

    // Credenciales OK → generar y enviar OTP
    const code      = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await emitirOtp(user.id, code, expiresAt);

    const esProduccion = (process.env['NODE_ENV'] ?? 'development') === 'production';

    let codigoLogeado = false;
    try {
      await sendOtpEmail(user.email, code, user.nombre);
    } catch (err) {
      app.log.error(err);
      // En producción el envío es obligatorio: no revelar el código y fallar.
      if (esProduccion) {
        return reply.code(500).send({ error: 'Error al enviar el código de verificación' });
      }
      // Fallback dev: se expone el código en el log y en la respuesta.
      app.log.warn(`[OTP FALLBACK] Código de verificación para ${user.email}: ${code}`);
      codigoLogeado = true;
    }

    return reply.send({
      requires2fa: true,
      email:       user.email,
      message:     codigoLogeado ? 'Código generado (email no enviado). Revisa el log del backend.' : 'Código de verificación enviado a tu email',
      otpDev:      codigoLogeado ? code : undefined
    });
  });


  // ─── POST /api/auth/verify-otp ─────────────────────────────────────────────
  app.post<{ Body: VerifyOtpBody }>('/verify-otp', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'code'],
        properties: {
          email: { type: 'string' },
          code:  { type: 'string', minLength: 6, maxLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const { email, code } = request.body;

    // El código vale solo para la cuenta de ese correo (antes se buscaba por código y,
    // si dos cuentas tenían el mismo código vigente, ninguna podía entrar). Se marca
    // como usado en la misma sentencia: un segundo envío del mismo código ya no entra.
    const [user] = await sql<{ id: string; email: string; nombre: string; username: string | null; rol: JwtPayload['rol']; foto_url: string | null; activo: boolean }[]>`
      with valido as (
        update otp_codes o set used = true
        from users u
        where u.id = o.user_id and u.email = ${email.toLowerCase().trim()}
          and o.code = ${code} and not o.used and o.expires_at > now()
        returning o.user_id
      )
      select u.id, u.email, u.nombre, u.username, u.rol, u.foto_url, u.activo
      from users u join valido v on v.user_id = u.id
      limit 1`;

    if (!user) {
      return reply.code(401).send({ error: 'Código inválido o expirado' });
    }

    const payload: JwtPayload = {
      sub:   user.id,
      email: user.email,
      rol:   user.rol
    };

    const token = app.jwt.sign(payload);

    await registrarAudit(app, {
      user_id: user.id,
      email:   user.email,
      accion:  'LOGIN',
      detalle: `Inicio de sesión exitoso (${user.nombre})`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ token, user });
  });


  // ─── POST /api/auth/logout ─────────────────────────────────────────────────
  app.post('/logout', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'LOGOUT',
      detalle: 'Cierre de sesión',
      ip:      ipDeRequest(request)
    });

    return reply.send({ message: 'Sesión cerrada' });
  });


  // ─── GET /api/auth/google ──────────────────────────────────────────────────
  // ?app=movil: la app Android abre esta URL en el navegador y pide que al final
  // se regrese a ella (skonditbeats://login) en lugar de a la página web.
  app.get<{ Querystring: { app?: string } }>('/google', async (request, reply) => {
    const url = googleClient.generateAuthUrl({
      access_type: 'offline',
      scope:       ['email', 'profile'],
      prompt:      'select_account',
      ...(request.query.app === 'movil' ? { state: ORIGEN_MOVIL } : {})
    });
    return reply.redirect(url);
  });


  // ─── GET /api/auth/google/callback ────────────────────────────────────────
  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/google/callback',
    async (request, reply) => {
      const { code, error, state } = request.query;
      // Mismo flujo para web y app; solo cambia a dónde se regresa. Nunca se manda
      // el token en la URL: el usuario todavía debe escribir el código OTP.
      const frontendUrl = state === ORIGEN_MOVIL
        ? REGRESO_MOVIL
        : (process.env['FRONTEND_URL'] ?? 'http://localhost:4200');

      if (error || !code) {
        return reply.redirect(`${frontendUrl}/login?error=google_cancelled`);
      }

      try {
        const { tokens } = await googleClient.getToken(code);
        googleClient.setCredentials(tokens);

        const ticket = await googleClient.verifyIdToken({
          idToken:  tokens.id_token!,
          audience: process.env['GOOGLE_CLIENT_ID']
        });

        const googlePayload = ticket.getPayload();
        if (!googlePayload?.email) {
          return reply.redirect(`${frontendUrl}/login?error=google_no_email`);
        }

        const googleEmail  = googlePayload.email.toLowerCase();
        const googleNombre = googlePayload.name    ?? googleEmail.split('@')[0];
        const googleFoto   = googlePayload.picture ?? null;

        type CuentaGoogle = { id: string; email: string; nombre: string; foto_url: string | null; activo: boolean };
        let [user] = await sql<CuentaGoogle[]>`
          select id, email, nombre, foto_url, activo from users where email = ${googleEmail}`;

        if (!user) {
          try {
            [user] = await sql<CuentaGoogle[]>`
              insert into users ${sql({
                email:       googleEmail,
                password:    await bcrypt.hash(Math.random().toString(36), 12),
                nombre:      googleNombre,
                foto_url:    googleFoto,
                rol:         'CLIENTE',
                permissions: sql.array([]),
                username:    null
              })}
              returning id, email, nombre, foto_url, activo`;
          } catch (createError) {
            app.log.error(createError);
            return reply.redirect(`${frontendUrl}/login?error=google_create_failed`);
          }
        }

        if (!user.activo) {
          return reply.redirect(`${frontendUrl}/login?error=account_disabled`);
        }

        if (googleFoto && user.foto_url !== googleFoto) {
          await sql`update users set foto_url = ${googleFoto}, updated_at = now() where id = ${user.id}`;
        }

        // Google ya autenticó la identidad → generar y enviar OTP a su correo
        const otpCode   = generateOtp();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await emitirOtp(user.id, otpCode, expiresAt);

        const esProduccion = (process.env['NODE_ENV'] ?? 'development') === 'production';

        try {
          // enviarAlPropio = true → el código siempre va al correo del usuario
          await sendOtpEmail(user.email, otpCode, user.nombre, true);
        } catch (err) {
          app.log.error(err);
          if (esProduccion) {
            return reply.redirect(`${frontendUrl}/login?error=google_otp_failed`);
          }
          app.log.warn(`[OTP FALLBACK] Código de verificación para ${user.email}: ${otpCode}`);
        }

        // Volver al login mostrando el paso 2 (OTP) con el email precargado
        const emailEncoded = encodeURIComponent(user.email);
        const otpDev       = !esProduccion ? `&otpDev=${otpCode}` : '';
        return reply.redirect(`${frontendUrl}/login?google=1&email=${emailEncoded}${otpDev}`);

      } catch (err) {
        app.log.error(err);
        return reply.redirect(`${frontendUrl}/login?error=google_failed`);
      }
    }
  );


  // ─── GET /api/auth/me ──────────────────────────────────────────────────────
  app.get('/me', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const [user] = await sql`
      select id, email, nombre, username, rol, foto_url, direccion, telefono, edad, fecha_registro
      from users where id = ${request.user.sub}`;

    if (!user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    return reply.send({ user });
  });
}


type CuentaLogin = {
  id: string; email: string; nombre: string; username: string | null; rol: JwtPayload['rol'];
  password: string; foto_url: string | null; activo: boolean;
  intentos_fallidos: number | null; bloqueado_hasta: string | null;
};

/** Invalida los códigos anteriores del usuario y guarda el nuevo, en una transacción. */
async function emitirOtp(userId: string, code: string, expiresAt: Date): Promise<void> {
  await sql.begin(async tx => {
    await tx`update otp_codes set used = true where user_id = ${userId} and not used`;
    await tx`insert into otp_codes (user_id, code, expires_at) values (${userId}, ${code}, ${expiresAt})`;
  });
}
