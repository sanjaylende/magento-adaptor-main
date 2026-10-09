// Generic entity-attribute-value access on PostgreSQL. Knows nothing about videos: callers pass an entity type code and a
// plain object of { attributeCode: value }; values are routed to the right typed table and (de)serialized here.
// Tenant isolation: every entity carries a store_id; callers pass it on create, and row-level security does the rest.
const { query } = require("../connection");

const BACKEND_TABLES = ["varchar", "int", "text", "datetime", "decimal"];

// The only dynamic part of any SQL in this service is the value-table name. It must be one of the five fixed names above, so a
// bad attribute definition can never put arbitrary text into a statement.
function safeTable(table) {
  if (!BACKEND_TABLES.includes(table)) throw new Error(`Unsupported EAV value table "${table}"`);
  return table;
}

function encode(value, frontend) {
  if (value === undefined || value === null) return null;
  if (frontend === "json") return JSON.stringify(value);
  if (frontend === "bool") return value ? 1 : 0;
  return value;
}

function decode(value, frontend) {
  if (value === null || value === undefined) return null;
  if (frontend === "json") return JSON.parse(value);
  if (frontend === "bool") return Number(value) === 1;
  if (frontend === "datetime") return new Date(value).toISOString();
  return value;
}

class EavRepository {
  constructor() {
    this.schemaCache = new Map(); // entityType -> { typeId, byCode, byId }
  }

  async _schema(entityType) {
    if (this.schemaCache.has(entityType)) return this.schemaCache.get(entityType);
    const { rows: [type] } = await query("SELECT entity_type_id FROM eav_entity_type WHERE code = $1", [entityType]);
    if (!type) throw new Error(`Unknown EAV entity type "${entityType}"`);
    const { rows } = await query("SELECT attribute_id, code, backend_type, frontend_type FROM eav_attribute WHERE entity_type_id = $1", [type.entity_type_id]);
    const schema = {
      typeId: type.entity_type_id,
      byCode: new Map(rows.map((r) => [r.code, r])),
      byId: new Map(rows.map((r) => [r.attribute_id, r])),
    };
    this.schemaCache.set(entityType, schema);
    return schema;
  }

  // Inserts the entity and its values. Returns the new entity id.
  async create(entityType, values = {}, { storeId, parentId = null } = {}) {
    if (!storeId) throw new Error("EAV create requires a storeId");
    const schema = await this._schema(entityType);
    const { rows: [row] } = await query(
      "INSERT INTO eav_entity (entity_type_id, store_id, parent_id) VALUES ($1, $2, $3) RETURNING entity_id",
      [schema.typeId, storeId, parentId]
    );
    await this._writeValues(row.entity_id, schema, values);
    return row.entity_id;
  }

  // Merges values into an existing entity (null/undefined clears an attribute). Returns false if it doesn't exist.
  async update(entityType, entityId, values = {}) {
    const schema = await this._schema(entityType);
    const res = await query("UPDATE eav_entity SET updated_at = now() WHERE entity_id = $1 AND entity_type_id = $2", [entityId, schema.typeId]);
    if (!res.rowCount) return false;
    await this._writeValues(entityId, schema, values);
    return true;
  }

  // Deleting an entity cascades to its values and to child entities.
  async delete(entityId) {
    return (await query("DELETE FROM eav_entity WHERE entity_id = $1", [entityId])).rowCount > 0;
  }

  async _writeValues(entityId, schema, values) {
    const upserts = new Map(); // table -> [[attributeId, value]]
    const deletes = new Map(); // table -> [attributeId]
    for (const [code, raw] of Object.entries(values)) {
      const attr = schema.byCode.get(code);
      if (!attr) throw new Error(`Unknown attribute "${code}"`);
      const value = encode(raw, attr.frontend_type);
      const bucket = value === null ? deletes : upserts;
      if (!bucket.has(attr.backend_type)) bucket.set(attr.backend_type, []);
      bucket.get(attr.backend_type).push(value === null ? attr.attribute_id : [attr.attribute_id, value]);
    }
    for (const [table, ids] of deletes) {
      await query(`DELETE FROM eav_entity_${safeTable(table)} WHERE entity_id = $1 AND attribute_id = ANY($2::bigint[])`, [entityId, ids]);
    }
    for (const [table, pairs] of upserts) {
      const params = [entityId];
      const tuples = pairs.map(([attrId, value]) => {
        params.push(attrId, value);
        return `($1, $${params.length - 1}, $${params.length})`;
      });
      await query(
        `INSERT INTO eav_entity_${safeTable(table)} (entity_id, attribute_id, value) VALUES ${tuples.join(", ")}
         ON CONFLICT (entity_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        params
      );
    }
  }

  // Loads entities by id: [{ id, storeId, parentId, createdAt, updatedAt, values }], in the order of ids.
  async loadMany(entityType, ids) {
    if (!ids.length) return [];
    const schema = await this._schema(entityType);
    const { rows } = await query("SELECT * FROM eav_entity WHERE entity_type_id = $1 AND entity_id = ANY($2::bigint[])", [schema.typeId, ids]);
    const byId = new Map(rows.map((r) => [r.entity_id, {
      id: r.entity_id, storeId: r.store_id, parentId: r.parent_id,
      createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), values: {},
    }]));
    const found = [...byId.keys()];
    if (found.length) {
      await Promise.all(BACKEND_TABLES.map(async (table) => {
        const { rows: vals } = await query(`SELECT entity_id, attribute_id, value FROM eav_entity_${safeTable(table)} WHERE entity_id = ANY($1::bigint[])`, [found]);
        for (const v of vals) {
          const attr = schema.byId.get(v.attribute_id);
          const entity = byId.get(v.entity_id);
          if (attr && entity) entity.values[attr.code] = decode(v.value, attr.frontend_type);
        }
      }));
    }
    return ids.map((id) => byId.get(Number(id))).filter(Boolean);
  }

  async load(entityType, id) {
    return (await this.loadMany(entityType, [Number(id)]))[0] || null;
  }

  // Ids of entities of a type, optionally narrowed by store, parent and/or attribute equality filters { code: value }.
  async findIds(entityType, { storeId, parentId, where = {} } = {}) {
    const schema = await this._schema(entityType);
    const joins = [];
    const clauses = ["e.entity_type_id = $1"];
    const params = [schema.typeId];
    const add = (v) => { params.push(v); return `$${params.length}`; };
    if (storeId !== undefined) clauses.push(`e.store_id = ${add(storeId)}`);
    if (parentId !== undefined) clauses.push(`e.parent_id = ${add(parentId)}`);
    Object.entries(where).forEach(([code, raw], i) => {
      const attr = schema.byCode.get(code);
      if (!attr) throw new Error(`Unknown attribute "${code}"`);
      joins.push(`JOIN eav_entity_${safeTable(attr.backend_type)} v${i} ON v${i}.entity_id = e.entity_id AND v${i}.attribute_id = ${add(attr.attribute_id)}`);
      clauses.push(`v${i}.value = ${add(encode(raw, attr.frontend_type))}`);
    });
    const { rows } = await query(`SELECT e.entity_id FROM eav_entity e ${joins.join(" ")} WHERE ${clauses.join(" AND ")} ORDER BY e.entity_id`, params);
    return rows.map((r) => r.entity_id);
  }

  async findAll(entityType, opts) {
    return this.loadMany(entityType, await this.findIds(entityType, opts));
  }

  async findOne(entityType, opts) {
    const ids = await this.findIds(entityType, opts);
    return ids.length ? this.load(entityType, ids[0]) : null;
  }
}

module.exports = new EavRepository();
module.exports.safeTable = safeTable;
