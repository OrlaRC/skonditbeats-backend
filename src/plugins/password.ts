export const MIN_LENGTH = 10;

export interface PasswordPolicy {
  minLength:    number;
  requiereMayuscula:  boolean;
  requiereMinuscula:  boolean;
  requiereNumero:     boolean;
  requiereEspecial:   boolean;
}

export const PASSWORD_POLICY: PasswordPolicy = {
  minLength:          MIN_LENGTH,
  requiereMayuscula:  true,
  requiereMinuscula:  true,
  requiereNumero:     true,
  requiereEspecial:   true
};

export function validarPoliticaPassword(password: string): string | null {
  if (!password || password.length < MIN_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_LENGTH} caracteres`;
  }
  if (!/[A-Z]/.test(password)) {
    return 'Debe incluir al menos una letra mayúscula';
  }
  if (!/[a-z]/.test(password)) {
    return 'Debe incluir al menos una letra minúscula';
  }
  if (!/\d/.test(password)) {
    return 'Debe incluir al menos un número';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'Debe incluir al menos un carácter especial';
  }
  return null;
}

export const DESCRIPCION_POLITICA =
  `Mínimo ${MIN_LENGTH} caracteres, una mayúscula, una minúscula, un número y un carácter especial`;
