'use strict';

/**
 * Cliente Supabase falso, solo para los tests. Implementa el subconjunto de la
 * API de consulta que usa Watchtower sobre un store en memoria.
 */

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function ilike(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'is').test(String(value ?? ''));
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

class Query {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.from = null;
    this.to = null;
    this.op = 'select';
    this.countOnly = false;
    this.columns = '*';
    this.payload = null;
    this.conflict = 'id';
  }

  get rows() {
    if (!this.store.has(this.table)) this.store.set(this.table, []);
    return this.store.get(this.table);
  }

  select(columns = '*', options = {}) {
    if (this.op === 'select') {
      this.columns = columns;
      this.countOnly = Boolean(options.count === 'exact' && options.head);
    }
    return this;
  }

  insert(rows) {
    this.op = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(row, options = {}) {
    this.op = 'upsert';
    this.payload = row;
    this.conflict = options.onConflict || 'id';
    return this;
  }

  update(patch) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }

  neq(column, value) {
    this.filters.push((row) => String(row[column]) !== String(value));
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => compare(row[column], value) >= 0);
    return this;
  }

  lte(column, value) {
    this.filters.push((row) => compare(row[column], value) <= 0);
    return this;
  }

  in(column, values) {
    const set = new Set(values.map(String));
    this.filters.push((row) => set.has(String(row[column])));
    return this;
  }

  or(expression) {
    const clauses = String(expression)
      .split(',')
      .map((part) => part.match(/^([\w.]+)\.([\w]+)\.(.*)$/))
      .filter(Boolean)
      .map(([, column, operator, value]) => (row) => {
        if (operator === 'ilike') return ilike(row[column], value);
        if (operator === 'eq') return String(row[column]) === value;
        return false;
      });

    this.filters.push((row) => clauses.some((clause) => clause(row)));
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count) {
    this.limitN = count;
    return this;
  }

  range(from, to) {
    this.from = from;
    this.to = to;
    return this;
  }

  matches() {
    return this.rows.filter((row) => this.filters.every((filter) => filter(row)));
  }

  execute() {
    let selected = this.matches();

    if (this.op === 'insert') {
      const inserted = this.payload.map((row) => {
        const next = { ...row };
        if (next.id === undefined) next.id = this.rows.length + 1;
        if (next.created_at === undefined) next.created_at = new Date().toISOString();
        return next;
      });
      this.rows.push(...inserted);
      return { data: clone(inserted), error: null };
    }

    if (this.op === 'upsert') {
      const key = this.conflict;
      const existing = this.rows.find((row) => String(row[key]) === String(this.payload[key]));
      if (existing) {
        Object.assign(existing, this.payload);
        return { data: clone(existing), error: null };
      }
      const next = { ...this.payload, created_at: this.payload.created_at ?? new Date().toISOString() };
      this.rows.push(next);
      return { data: clone(next), error: null };
    }

    if (this.op === 'update') {
      for (const row of selected) Object.assign(row, this.payload);
      return { data: clone(selected), error: null };
    }

    if (this.op === 'delete') {
      const kept = this.rows.filter((row) => !selected.includes(row));
      this.store.set(this.table, kept);
      return { data: clone(selected), error: null };
    }

    for (const { column, ascending } of [...this.orders].reverse()) {
      selected = [...selected].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
    }

    if (this.countOnly) {
      return { data: null, count: selected.length, error: null };
    }

    if (this.from !== null) {
      selected = selected.slice(this.from, this.to === null ? undefined : this.to + 1);
    }
    if (this.limitN !== null) selected = selected.slice(0, this.limitN);

    let data = clone(selected);
    if (this.columns !== '*' && typeof this.columns === 'string') {
      const columns = this.columns.split(',').map((column) => column.trim()).filter(Boolean);
      data = data.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    }

    return { data, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }

  catch(reject) {
    return this.then(undefined, reject);
  }
}

function createFakeSupabase(store = new Map()) {
  return {
    store,
    from(table) {
      return new Query(store, table);
    },
  };
}

module.exports = { createFakeSupabase };
