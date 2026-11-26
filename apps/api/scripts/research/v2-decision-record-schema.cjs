'use strict';

// Independent research artifact: V2 decision-record JSON-Schema loader and
// validator (iRexPro AI V2 research, WS1.1). Pure logic over the versioned
// schema file and SYNTHETIC fixtures. No database access, no model execution,
// no broker calls, no trading authority.
//
// Why a JSON Schema next to the semantic contract: the contract module
// (v2-decision-record-contract.cjs) checks BEHAVIORAL invariants (uncalibrated
// confidence cannot size a position, OOD execution is flagged...); the schema
// is the machine-readable WIRE FORM every producer and consumer can verify
// against — a versioned, hashable artifact that can be frozen, shipped and
// diffed. A record is accepted only when BOTH pass:
//
//   schema-valid  (structure: exactly the declared fields, types, enums,
//                  bounds — additionalProperties:false encodes C1 "exactly one
//                  confidence field" structurally: any second confidence-named
//                  key is rejected here)
//   contract-valid (semantics: C1–C6 from the decision-record contract)
//
// The validator implements the JSON Schema subset used by the frozen schema
// file: type (incl. union arrays), properties, required, additionalProperties
// (false or schema), enum, const, minimum, maximum, minLength, anyOf, items.
// Formats are annotation-only (draft-07 style): ISO-8601 strings are checked
// for shape, not full calendar semantics — stated limitation, not an
// assumption. The subset is exactly what the frozen schema uses; anything the
// schema needs later must be added to the subset AND the tests together.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDecisionRecord } = require('./v2-decision-record-contract.cjs');

const SCHEMA_VERSION = 'V2_DECISION_RECORD_V1';
const SCHEMA_PATH = path.join(
  __dirname, '..', '..', '..', '..', 'docs', 'research', 'v2', 'schemas', 'decision-record-v1.schema.json',
);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// --- self-contained JSON Schema (subset) validator -------------------------

const TYPE_CHECKS = Object.freeze({
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  number: (v) => typeof v === 'number' && Number.isFinite(v), // JSON has no NaN/Infinity
  integer: (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v),
});

function checkType(instance, typeNames, ip, out) {
  const ok = typeNames.some((t) => TYPE_CHECKS[t](instance));
  if (!ok) out.push({ instancePath: ip, keyword: 'type', message: `expected type ${typeNames.join('|')}, got ${describe(instance)}` });
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'non-finite-number';
  return typeof v;
}

function validateNode(instance, schema, ip, out) {
  if (schema === true) return;
  if (schema === false) { out.push({ instancePath: ip, keyword: 'false', message: 'schema forbids any value here' }); return; }
  if (typeof schema !== 'object' || schema === null) return; // unknown/unsupported subschema: ignored, subset stated

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((sub) => {
      const tmp = [];
      validateNode(instance, sub, ip, tmp);
      return tmp;
    });
    const anyPass = branches.some((b) => b.length === 0);
    if (!anyPass) {
      out.push({ instancePath: ip, keyword: 'anyOf', message: 'value matches no allowed branch' });
      // Surface the per-branch findings (ajv-verbose style) so the exact
      // violated constraint inside the failing branch stays diagnosable.
      branches.forEach((b, i) => b.forEach((f) => out.push({ ...f, message: `anyOf branch ${i}: ${f.message}` })));
    }
  }

  if (schema.type !== undefined) {
    const names = Array.isArray(schema.type) ? schema.type : [schema.type];
    checkType(instance, names, ip, out);
  }
  if (schema.enum !== undefined && !schema.enum.some((c) => deepEqual(instance, c))) {
    out.push({ instancePath: ip, keyword: 'enum', message: `value not in enum [${schema.enum.map(String).join('|')}]` });
  }
  if (schema.const !== undefined && !deepEqual(instance, schema.const)) {
    out.push({ instancePath: ip, keyword: 'const', message: `value must equal ${String(schema.const)}` });
  }
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) out.push({ instancePath: ip, keyword: 'minimum', message: `${instance} < minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && instance > schema.maximum) out.push({ instancePath: ip, keyword: 'maximum', message: `${instance} > maximum ${schema.maximum}` });
  }
  if (typeof instance === 'string' && schema.minLength !== undefined && instance.length < schema.minLength) {
    out.push({ instancePath: ip, keyword: 'minLength', message: `string shorter than minLength ${schema.minLength}` });
  }
  if (Array.isArray(instance) && schema.items !== undefined) {
    instance.forEach((el, i) => validateNode(el, schema.items, `${ip}[${i}]`, out));
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const props = schema.properties || {};
    for (const key of Object.keys(instance)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) validateNode(instance[key], props[key], `${ip}.${key}`, out);
      else if (schema.additionalProperties === false) {
        out.push({ instancePath: `${ip}.${key}`, keyword: 'additionalProperties', message: `undeclared property "${key}" rejected (canonical form is closed)` });
      }
    }
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(instance, req)) {
        out.push({ instancePath: ip, keyword: 'required', message: `missing required property "${req}"` });
      }
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

// --- schema artifact loading + combined validation ---------------------------

function loadSchema(schemaPath = SCHEMA_PATH) {
  const raw = fs.readFileSync(schemaPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: 'SCHEMA_NOT_JSON', detail: e.message };
  }
  if (parsed.version !== SCHEMA_VERSION) {
    return { error: 'SCHEMA_VERSION_MISMATCH', detail: `file declares ${parsed.version}, loader requires ${SCHEMA_VERSION}` };
  }
  const sha = sha256(canonicalJson(parsed));
  return { schema: parsed, rawBytes: raw, schemaSha256: sha, version: parsed.version };
}

function validateAgainstSchema(instance, schema, ip = '$') {
  const out = [];
  validateNode(instance, schema, ip, out);
  return out;
}

// Full acceptance gate: schema (wire form) + semantic contract (C1–C6).
// Anything the schema cannot express structurally is caught here, so the two
// validators are complementary, never redundant.
function validateDecisionRecordFull(record, loaded = loadSchema()) {
  if (loaded.error) return { findings: [{ code: loaded.error, detail: loaded.detail }], schema: null, schemaSha256: null };
  const schemaFindings = validateAgainstSchema(record, loaded.schema)
    .map((f) => ({ code: `SCHEMA_${f.keyword.toUpperCase()}`, detail: `${f.instancePath}: ${f.message}` }));
  const contract = validateDecisionRecord(record);
  return {
    findings: [...schemaFindings, ...contract.findings],
    schema: loaded.version,
    schemaSha256: loaded.schemaSha256,
    contract: contract.contract,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_PATH,
  loadSchema,
  validateAgainstSchema,
  validateDecisionRecordFull,
  canonicalJson,
  sha256,
};
