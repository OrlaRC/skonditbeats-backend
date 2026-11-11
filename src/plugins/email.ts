const BREVO_API_KEY = process.env['BREVO_API_KEY'];
const EMAIL_FROM    = process.env['EMAIL_FROM'] ?? 'SkonditBeats';
const EMAIL_SENDER  = process.env['EMAIL_SENDER'] ?? 'skonditbeats@example.com';
const DEV_EMAIL_TO  = process.env['DEV_EMAIL_TO'] ?? '';
const OTP_REDIRECT_EMAILS = (process.env['OTP_REDIRECT_EMAILS'] ?? '')
  .split(',')
  .map((em) => em.trim().toLowerCase())
  .filter(Boolean);

const escaparHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Avisa al cliente de la respuesta del administrador a su mensaje de contacto.
export async function sendContactReplyEmail(to: string, nombre: string, texto: string, devuelto: boolean): Promise<void> {
  if (!BREVO_API_KEY) {
    throw new Error('Falta BREVO_API_KEY en las variables de entorno');
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#0a0a0a;color:#fff;border-radius:12px;padding:30px;">
      <h1 style="color:#facc15;margin:0 0 16px;">SkonditBeats</h1>
      <p style="color:#ccc;">Hola <strong style="color:#fff;">${escaparHtml(nombre)}</strong>,
      ${devuelto ? 'necesitamos más información sobre tu mensaje:' : 'respondimos tu mensaje:'}</p>
      <p style="color:#fff;white-space:pre-wrap;">${escaparHtml(texto)}</p>
      <p style="color:#666;font-size:0.8rem;">Puedes continuar la conversación en la app, en Contacto &gt; Mis mensajes.</p>
    </div>
  `;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Api-Key':      BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender:      { name: EMAIL_FROM, email: EMAIL_SENDER },
      to:          [{ email: to }],
      subject:     devuelto ? 'Necesitamos más información — SkonditBeats' : 'Respondimos tu mensaje — SkonditBeats',
      htmlContent: html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Error Brevo: ${res.status} ${err}`);
  }
}

export async function sendOtpEmail(to: string, code: string, nombre: string, enviarAlPropio = false): Promise<void> {
  if (!BREVO_API_KEY) {
    throw new Error('Falta BREVO_API_KEY en las variables de entorno');
  }

  // Redirigir el OTP solo para cuentas existentes en la lista OTP_REDIRECT_EMAILS.
  // Las demás (cuentas nuevas, incluido login con Google) reciben su propio correo.
  const destEmail   = to.trim().toLowerCase();
  const esRedirigido = !enviarAlPropio && Boolean(DEV_EMAIL_TO) && OTP_REDIRECT_EMAILS.includes(destEmail);
  const recipient   = esRedirigido ? DEV_EMAIL_TO : to;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#000,#111);padding:30px;text-align:center;">
        <h1 style="color:#facc15;margin:0;">SkonditBeats</h1>
        <p style="color:#aaa;margin-top:8px;">Verificación en 2 pasos</p>
      </div>
      <div style="padding:30px;text-align:center;">
        ${esRedirigido ? `<p style="color:#f87171;font-size:0.8rem;">[DEV] Email redirigido desde: ${to}</p>` : ''}
        <p style="color:#ccc;">Hola <strong style="color:#fff;">${nombre}</strong>, tu código de verificación es:</p>
        <div style="background:#facc15;color:#000;font-size:2.5rem;font-weight:bold;letter-spacing:0.5rem;padding:20px 30px;border-radius:10px;display:inline-block;margin:20px 0;">
          ${code}
        </div>
        <p style="color:#aaa;font-size:0.85rem;">Este código expira en <strong style="color:#fff;">10 minutos</strong>.</p>
        <p style="color:#666;font-size:0.8rem;">Si no solicitaste este código, ignora este mensaje.</p>
      </div>
    </div>
  `;

  // Brevo (Sendinblue) SMTP API v3
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Accept':       'application/json',
      'Api-Key':      BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender:      { name: EMAIL_FROM, email: EMAIL_SENDER },
      to:          [{ email: recipient }],
      subject:     'Tu código de verificación — SkonditBeats',
      htmlContent: html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Error Brevo: ${res.status} ${err}`);
  }
}