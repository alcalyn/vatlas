import { describe, expect, it } from 'vitest';
import { hashPassword, isAcceptablePassword, verifyPassword } from '../src/services/passwords.js';

describe('passwords', () => {
  it('verifies the password it hashed, and nothing else', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
  });

  // A salt per hash: two identical passwords give different rows.
  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  // A corrupt row reads as a wrong password, not a 500.
  it.each(['', 'bcrypt$x', 'scrypt$0$8$1$c2FsdA$aGFzaA', 'scrypt$3$8$1$c2FsdA$aGFzaA', 'scrypt$16384$8$1$c2FsdA$'])(
    'refuses a stored value it cannot read: %j',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );

  it('accepts lengths between the floor and the ceiling only', () => {
    expect(isAcceptablePassword('123456789')).toBe(false);
    expect(isAcceptablePassword('1234567890')).toBe(true);
    expect(isAcceptablePassword('x'.repeat(128))).toBe(true);
    expect(isAcceptablePassword('x'.repeat(129))).toBe(false);
  });
});
