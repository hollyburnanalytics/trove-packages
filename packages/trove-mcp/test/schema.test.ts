import { describe, expect, it } from 'vitest';
import { z } from '../src/index.js';
import { compileInputSchema } from '../src/schema.js';

describe('compileInputSchema', () => {
  it('compiles a flat object schema with required + descriptions', () => {
    const schema = compileInputSchema(
      z.object({
        a: z.string().describe('field a'),
        b: z.number().optional(),
      }),
    );
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['a']);
    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    expect(props.a).toMatchObject({ type: 'string', description: 'field a' });
    expect(props.b).toMatchObject({ type: 'number' });
    expect(schema.$schema).toBeUndefined();
  });

  it('compiles nested objects and enums', () => {
    const schema = compileInputSchema(
      z.object({
        kind: z.enum(['x', 'y']),
        nested: z.object({ deep: z.boolean() }),
      }),
    );
    const props = schema.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(props.kind?.enum).toEqual(['x', 'y']);
    expect(props.nested?.type).toBe('object');
  });

  it('throws on a non-object root schema', () => {
    expect(() => compileInputSchema(z.string())).toThrow(/must be an object/);
  });

  it('handles an empty object schema', () => {
    const schema = compileInputSchema(z.object({}));
    expect(schema.type).toBe('object');
  });

  it('inlines deeply-nested object schemas (no top-level $ref)', () => {
    const schema = compileInputSchema(
      z.object({
        a: z.object({ b: z.object({ c: z.array(z.string()) }) }),
      }),
    );
    expect(schema.type).toBe('object');
    expect(schema.$ref).toBeUndefined();
    const props = schema.properties as Record<string, { type?: string }>;
    expect(props.a?.type).toBe('object');
  });
});
