import type { FastifyInstance }  from 'fastify';
import bcrypt                    from 'bcryptjs';
import { OAuth2Client }          from 'google-auth-library';
import { supabase }              from '../../db/supabase';
import { sendOtpEmail }          from '../../plugins/email';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';
import type { JwtPayload }       from '../../types/index';

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
          email:     { type: 'string' },
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

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existing) {
      return reply.code(409).send({ error: 'El email ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email:       email.toLowerCase().trim(),
        password:    passwordHash,
        nombre,
        username:    username?.trim()  || null,
        direccion:   direccion?.trim() || null,
        telefono:    telefono?.trim()  || null,
        edad:        edad ?? null,
        rol:         'CLIENTE',
        permissions: []
      })
      .select('id, email, nombre, username, rol, fecha_registro')
      .single();

    if (error) {
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

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, nombre, username, rol, password, foto_url, activo, intentos_fallidos, bloqueado_hasta')
      .eq('email', emailNormalizado)
      .maybeSingle();

    if (error || !user) {
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
        update.bloqueado_hasta   = new Date(Date.now() + TIEMPO_BLOQUEO_MS).toISOString();
      }

      await supabase.from('users').update(update).eq('id', user.id);

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
      await supabase
        .from('users')
        .update({ intentos_fallidos: 0, bloqueado_hasta: null })
        .eq('id', user.id);
    }

    // Credenciales OK → los administradores entran directo (sin OTP)
    if (user.rol === 'ADMIN') {
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

    // Invalidar OTPs anteriores
    await supabase
      .from('otp_codes')
      .update({ used: true })
      .eq('user_id', user.id)
      .eq('used', false);

    await supabase
      .from('otp_codes')
      .insert({
        user_id:    user.id,
        code,
        expires_at: expiresAt.toISOString()
      });

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

    const { data: otp, error: otpError } = await supabase
      .from('otp_codes')
      .select('id, user_id, expires_at, used')
      .eq('code', code)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (otpError || !otp) {
      return reply.code(401).send({ error: 'Código inválido o expirado' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, nombre, username, rol, foto_url, activo')
      .eq('id', otp.user_id)
      .eq('email', email.toLowerCase().trim())
      .single();

    if (userError || !user) {
      return reply.code(401).send({ error: 'Código inválido o expirado' });
    }

    // Marcar OTP como usado
    await supabase
      .from('otp_codes')
      .update({ used: true })
      .eq('id', otp.id);

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
  app.get('/google', async (_request, reply) => {
    const url = googleClient.generateAuthUrl({
      access_type: 'offline',
      scope:       ['email', 'profile'],
      prompt:      'select_account'
    });
    return reply.redirect(url);
  });


  // ─── GET /api/auth/google/callback ────────────────────────────────────────
  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/google/callback',
    async (request, reply) => {
      const { code, error } = request.query;
      const frontendUrl = process.env['FRONTEND_URL'] ?? 'http://localhost:4200';

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

        let { data: user } = await supabase
          .from('users')
          .select('id, email, nombre, username, rol, foto_url, activo')
          .eq('email', googleEmail)
          .maybeSingle();

        if (!user) {
          const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert({
              email:       googleEmail,
              password:    await bcrypt.hash(Math.random().toString(36), 12),
              nombre:      googleNombre,
              foto_url:    googleFoto,
              rol:         'CLIENTE',
              permissions: [],
              username:    null
            })
            .select('id, email, nombre, username, rol, foto_url, activo')
            .single();

          if (createError || !newUser) {
            return reply.redirect(`${frontendUrl}/login?error=google_create_failed`);
          }

          user = newUser;
        }

        if (!user.activo) {
          return reply.redirect(`${frontendUrl}/login?error=account_disabled`);
        }

        if (googleFoto && user.foto_url !== googleFoto) {
          await supabase
            .from('users')
            .update({ foto_url: googleFoto, updated_at: new Date().toISOString() })
            .eq('id', user.id);
        }

        // Google ya autenticó la identidad → generar y enviar OTP a su correo
        const otpCode   = generateOtp();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await supabase
          .from('otp_codes')
          .update({ used: true })
          .eq('user_id', user.id)
          .eq('used', false);

        await supabase
          .from('otp_codes')
          .insert({
            user_id:    user.id,
            code:       otpCode,
            expires_at: expiresAt.toISOString()
          });

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
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, nombre, username, rol, foto_url, direccion, telefono, edad, fecha_registro')
      .eq('id', request.user.sub)
      .single();

    if (error || !user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    return reply.send({ user });
  });
}