import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { z, ZodSchema } from 'zod';
import { ApiException } from '../errors/api.exception';

/// Valida o corpo (@Body) com um schema Zod. Só mexe no body — num
/// @UsePipes de método o Nest passaria também @Param/@Query/@CurrentUser.
@Injectable()
export class ZodBody implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'body') return value;
    return parseOrThrow(this.schema, value ?? {});
  }
}

/// Valida a query string (@Query()).
@Injectable()
export class ZodQuery implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== 'query') return value;
    return parseOrThrow(this.schema, value ?? {});
  }
}

export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw ApiException.badRequest('VALIDATION_ERROR', undefined, details);
  }
  return result.data;
}
