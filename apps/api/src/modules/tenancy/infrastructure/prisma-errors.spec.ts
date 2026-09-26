import { describe, expect, it } from 'vitest';
import {
  InvalidReferenceError,
  RecordNotFoundError,
  TenantIsolationViolationError,
  UniqueConstraintError,
} from '../errors';
import { translateDatabaseError } from './prisma-errors';

const prismaError = (code: string, meta: object = {}) =>
  Object.assign(new Error(`prisma ${code}`), { code, meta });

describe('translateDatabaseError', () => {
  it('maps row-level security rejections', () => {
    const e = prismaError('P2010', {
      driverAdapterError: {
        cause: { code: '42501', message: 'new row violates row-level security policy' },
      },
    });
    expect(() => translateDatabaseError(e, 'x')).toThrow(TenantIsolationViolationError);
  });

  it('maps unique violations with their target columns', () => {
    const fromTarget = prismaError('P2002', { target: ['tenant_id', 'primary_email'] });
    expect(() => translateDatabaseError(fromTarget, 'person')).toThrow(UniqueConstraintError);
    try {
      translateDatabaseError(fromTarget, 'person');
    } catch (error) {
      expect((error as UniqueConstraintError).target).toBe('tenant_id, primary_email');
    }
    const fromAdapter = prismaError('P2002', {
      driverAdapterError: { cause: { constraint: { fields: ['slug'] } } },
    });
    try {
      translateDatabaseError(fromAdapter, 'tenant');
    } catch (error) {
      expect((error as UniqueConstraintError).target).toBe('slug');
    }
  });

  it('maps foreign key and not-found errors', () => {
    expect(() => translateDatabaseError(prismaError('P2003'), 'company')).toThrow(
      InvalidReferenceError,
    );
    expect(() => translateDatabaseError(prismaError('23503'), 'company')).toThrow(
      InvalidReferenceError,
    );
    expect(() => translateDatabaseError(prismaError('P2025'), 'company')).toThrow(
      RecordNotFoundError,
    );
  });

  it('rethrows unknown errors unchanged', () => {
    const e = new Error('connection reset');
    expect(() => translateDatabaseError(e, 'x')).toThrow(e);
    expect(() => translateDatabaseError('weird', 'x')).toThrow('weird');
  });
});
