import type { ActionField } from "./schema.ts";

export type JsonSchema = Record<string, unknown>;

/** Converts action input fields into a JSON Schema object (used by MCP and OpenAPI). */
export function fieldsToJsonSchema(fields: ActionField[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldToJsonSchema(f);
    if (f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function fieldToJsonSchema(f: ActionField): JsonSchema {
  const base: JsonSchema = f.description ? { description: f.description } : {};
  switch (f.type) {
    case "string":
      return { ...base, type: "string", ...len(f) };
    case "phone":
      return { ...base, type: "string", pattern: PHONE.source };
    case "email":
      return { ...base, type: "string", format: "email" };
    case "date":
      return { ...base, type: "string", format: "date" };
    case "time":
      return { ...base, type: "string", pattern: TIME.source };
    case "datetime":
      return { ...base, type: "string", format: "date-time" };
    case "integer":
      return { ...base, type: "integer", ...range(f) };
    case "number":
      return { ...base, type: "number", ...range(f) };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "string", enum: f.enum ?? [] };
    case "array":
      return {
        ...base,
        type: "array",
        items: fieldsToJsonSchema(f.items ?? []),
        ...(f.min !== undefined ? { minItems: f.min } : {}),
        ...(f.max !== undefined ? { maxItems: f.max } : {}),
      };
  }
}

const range = (f: ActionField) => ({
  ...(f.min !== undefined ? { minimum: f.min } : {}),
  ...(f.max !== undefined ? { maximum: f.max } : {}),
});
const len = (f: ActionField) => ({
  ...(f.min !== undefined ? { minLength: f.min } : {}),
  ...(f.max !== undefined ? { maxLength: f.max } : {}),
});

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

/** Validates and lightly coerces input for an action. Unknown fields are rejected. */
export function validateInput(fields: ActionField[], input: unknown, path = ""): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: [`${path || "input"} must be an object`] };
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  const known = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) errors.push(`${path}${key} is not a known field`);
  }
  for (const f of fields) {
    const name = `${path}${f.name}`;
    const raw = obj[f.name];
    if (raw === undefined || raw === null || raw === "") {
      if (f.required) errors.push(`${name} is required`);
      continue;
    }
    const r = checkField(f, raw, name);
    if (typeof r === "string") errors.push(r);
    else value[f.name] = r.v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function checkField(f: ActionField, raw: unknown, name: string): string | { v: unknown } {
  switch (f.type) {
    case "integer":
    case "number": {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || Number.isNaN(n)) return `${name} must be a number`;
      if (f.type === "integer" && !Number.isInteger(n)) return `${name} must be a whole number`;
      if (f.min !== undefined && n < f.min) return `${name} must be at least ${f.min}`;
      if (f.max !== undefined && n > f.max) return `${name} must be at most ${f.max}`;
      return { v: n };
    }
    case "boolean":
      if (typeof raw === "boolean") return { v: raw };
      if (raw === "true" || raw === "false") return { v: raw === "true" };
      return `${name} must be true or false`;
    case "array": {
      if (!Array.isArray(raw)) return `${name} must be a list`;
      if (f.min !== undefined && raw.length < f.min) return `${name} needs at least ${f.min} items`;
      if (f.max !== undefined && raw.length > f.max) return `${name} allows at most ${f.max} items`;
      const out: unknown[] = [];
      for (let i = 0; i < raw.length; i++) {
        const r = validateInput(f.items ?? [], raw[i], `${name}[${i}].`);
        if (!r.ok) return r.errors.join("; ");
        out.push(r.value);
      }
      return { v: out };
    }
    default: {
      if (typeof raw !== "string") return `${name} must be text`;
      const s = raw.trim();
      if (f.type === "email" && !EMAIL.test(s)) return `${name} must be an email address`;
      if (f.type === "date" && (!DATE.test(s) || Number.isNaN(Date.parse(s)))) return `${name} must be a date like 2026-12-31`;
      if (f.type === "time" && !TIME.test(s)) return `${name} must be a time like 19:30`;
      if (f.type === "datetime" && Number.isNaN(Date.parse(s))) return `${name} must be an ISO date-time`;
      if (f.type === "phone" && !PHONE.test(s)) return `${name} must be a phone number`;
      if (f.type === "enum" && !(f.enum ?? []).includes(s)) return `${name} must be one of: ${(f.enum ?? []).join(", ")}`;
      if (f.type === "string" && f.min !== undefined && s.length < f.min) return `${name} is too short`;
      if (f.type === "string" && f.max !== undefined && s.length > f.max) return `${name} is too long`;
      return { v: s };
    }
  }
}
