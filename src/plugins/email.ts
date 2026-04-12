const RESEND_API_KEY = process.env['RESEND_API_KEY'];
const EMAIL_FROM     = process.env['EMAIL_FROM'] ?? 'onboarding@resend.dev';
const DEV_EMAIL_TO   = process.env['DEV_EMAIL_TO'] ?? '';

export async function sendOtpEmail(to: string, code: string, nombre: string): Promise<void> {
  if (!RESEND_API_KEY) {
    throw new Error('Falta RESEND_API_KEY en las variables de entorno');
  }

  // Siempre redirigir al DEV_EMAIL_TO si está configurado
  const recipient = DEV_EMAIL_TO || to;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#000,#111);padding:30px;text-align:center;">
        <h1 style="color:#facc15;margin:0;">SkonditBeats</h1>
        <p style="color:#aaa;margin-top:8px;">Verificación en 2 pasos</p>
      </div>
      <div style="padding:30px;text-align:center;">
        ${DEV_EMAIL_TO && DEV_EMAIL_TO !== to ? `<p style="color:#f87171;font-size:0.8rem;">[DEV] Email redirigido desde: ${to}</p>` : ''}
        <p style="color:#ccc;">Hola <strong style="color:#fff;">${nombre}</strong>, tu código de verificación es:</p>
        <div style="background:#facc15;color:#000;font-size:2.5rem;font-weight:bold;letter-spacing:0.5rem;padding:20px 30px;border-radius:10px;display:inline-block;margin:20px 0;">
          ${code}
        </div>
        <p style="color:#aaa;font-size:0.85rem;">Este código expira en <strong style="color:#fff;">10 minutos</strong>.</p>
        <p style="color:#666;font-size:0.8rem;">Si no solicitaste este código, ignora este mensaje.</p>
      </div>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    EMAIL_FROM,
      to:      [recipient],
      subject: 'Tu código de verificación — SkonditBeats',
      html
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Error Resend: ${JSON.stringify(err)}`);
  }
}