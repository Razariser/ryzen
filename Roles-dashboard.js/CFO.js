// Roles-dashboard.js/CFO.js — Chief Financial Officer (standalone)
//
// This file depends on NOTHING shared: no _helpers.js, no _records.js, and it
// ignores the `h` object the loader passes in. Everything the CFO seat needs
// is defined below, so changing this file cannot affect any other role.
//
// It keeps the same exports as before (role, title, departments, notBuilt,
// actions, load), so api/admin.js and Roles-dashboard.js/index.js load it
// exactly as they did — and Super Admin can still open it and use its forms.
//
// Revenue = paid / shipped / delivered orders, plus the records you enter:
// product costs, expenses, budgets, investments and tax records.

'use strict';

/* ────────────────────────── small helpers ────────────────────────── */

const DAY = 86400000;
const PAID_STATUSES = ['paid', 'shipped', 'delivered'];

const todayISO = () => new Date().toISOString().slice(0, 10);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Run a loader; on failure log it and return a fallback (default null) so one
// broken source never blanks the whole dashboard.
async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error(`cfo: ${label} failed:`, err && err.message);
    return fallback;
  }
}

async function listRows(supabase, table, { columns = '*', order, ascending = false, limit = 200 } = {}) {
  let query = supabase.from(table).select(columns);
  if (order) query = query.order(order, { ascending });
  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return data || [];
}

/* ────────────────────────── orders ────────────────────────── */

async function fetchOrders(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select('amount, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  return data || [];
}

function summarizeOrders(rows) {
  const byStatus = {};
  let revenue = 0, paidCount = 0, unpaidValue = 0, refundedValue = 0, cancelledValue = 0;
  for (const o of rows) {
    const status = o.status || 'unknown';
    const amount = Number(o.amount) || 0;
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (PAID_STATUSES.includes(status)) { revenue += amount; paidCount += 1; }
    else if (status === 'created') unpaidValue += amount;
    else if (status === 'refunded') refundedValue += amount;
    else if (status === 'cancelled') cancelledValue += amount;
  }
  return {
    total: rows.length,
    truncated: rows.length >= 5000,
    byStatus,
    revenue,
    paidCount,
    avgOrderValue: paidCount ? Math.round(revenue / paidCount) : 0,
    unpaidValue,
    refundedValue,
    cancelledValue,
  };
}

// Paid orders per day for the last `days` days (oldest first).
function dailyTrend(rows, days = 30) {
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    buckets.set(date, { date, orders: 0, revenue: 0 });
  }
  for (const o of rows) {
    if (!PAID_STATUSES.includes(o.status)) continue;
    const bucket = buckets.get(String(o.created_at).slice(0, 10));
    if (bucket) { bucket.orders += 1; bucket.revenue += Number(o.amount) || 0; }
  }
  return [...buckets.values()];
}

// Revenue from paid orders created between `fromDaysAgo` and `toDaysAgo`.
function windowRevenue(rows, fromDaysAgo, toDaysAgo) {
  const now = Date.now();
  let revenue = 0, orders = 0;
  for (const o of rows) {
    if (!PAID_STATUSES.includes(o.status)) continue;
    const age = now - new Date(o.created_at).getTime();
    if (age >= toDaysAgo * DAY && age < fromDaysAgo * DAY) { revenue += Number(o.amount) || 0; orders += 1; }
  }
  return { revenue, orders };
}

/* ────────────────────────── products and margins ────────────────────────── */

// products.json lives in the GitHub content repo. Returns null if it can't be loaded.
async function loadProducts(getJSON) {
  const { data } = await getJSON('public/products.json');
  return Array.isArray(data) ? data : null;
}

async function productNames(getJSON) {
  try {
    const list = await loadProducts(getJSON);
    return list ? list.map((p) => p.name).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

// Catalog price minus the cost entered in product_costs.
async function loadMargins(supabase, getJSON) {
  const [costs, products] = await Promise.all([
    listRows(supabase, 'product_costs', { columns: 'product_name, cost_price, fabric, supplier, updated_at', order: 'updated_at', limit: 300 }),
    loadProducts(getJSON),
  ]);
  let margins = { covered: 0, totalProducts: products ? products.length : null, averageMarginPct: null, lowest: [] };
  if (products) {
    const costByName = new Map(costs.map((c) => [c.product_name, Number(c.cost_price)]));
    const priced = products
      .filter((p) => costByName.has(p.name) && Number(p.price) > 0)
      .map((p) => {
        const price = Number(p.price), cost = costByName.get(p.name);
        return { name: p.name, price, cost, marginPct: Math.round(((price - cost) / price) * 100) };
      })
      .sort((a, b) => a.marginPct - b.marginPct);
    const totalPct = priced.reduce((sum, p) => sum + p.marginPct, 0);
    margins = {
      covered: priced.length,
      totalProducts: products.length,
      averageMarginPct: priced.length ? Math.round(totalPct / priced.length) : null,
      lowest: priced.slice(0, 5),
    };
  }
  return { margins, costs };
}

/* ────────────────────────── records: validation + save/delete actions ──────────────────────────
   Table and column names come ONLY from the descriptions below, never from
   the browser, and every value is checked before it reaches the database. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns the cleaned value, null (blank optional), or undefined (leave the column out).
function cleanValue(field, raw) {
  const blank = raw === undefined || raw === null || String(raw).trim() === '';
  if (blank) {
    if (field.required) throw httpError(400, `${field.label} is required.`);
    return field.dbDefault ? undefined : null;
  }
  const s = String(raw).trim();
  switch (field.type) {
    case 'number': {
      const n = Number(s);
      if (!Number.isFinite(n)) throw httpError(400, `${field.label} must be a number.`);
      if (field.min !== undefined && n < field.min) throw httpError(400, `${field.label} must be ${field.min} or more.`);
      if (field.max !== undefined && n > field.max) throw httpError(400, `${field.label} must be ${field.max} or less.`);
      return n;
    }
    case 'date':
      if (!validDate(s)) throw httpError(400, `${field.label} must be a valid date.`);
      return s;
    case 'month':
      if (!/^\d{4}-\d{2}$/.test(s) || !validDate(s + '-01')) throw httpError(400, `${field.label} must be a valid month.`);
      return s + '-01';
    case 'enum':
      if (!field.values.includes(s)) throw httpError(400, `${field.label} must be one of: ${field.values.join(', ')}.`);
      return s;
    default: {
      const max = field.long ? 1000 : 200;
      if (s.length > max) throw httpError(400, `${field.label} is too long (max ${max} characters).`);
      return s;
    }
  }
}

// Turn database errors into plain messages; anything unexpected is logged and shown generically.
function explain(err) {
  if (err && err.status) return err;
  const code = err && err.code;
  if (code === '23503') return httpError(409, 'Other records still use this. Remove those first.');
  if (code === '23505') return httpError(409, 'That record already exists.');
  if (code === '23514') return httpError(400, 'One of the values is not allowed.');
  if (code === '42P01' || code === 'PGRST205') return httpError(500, 'This section\u2019s table has not been created yet. Run the SQL setup file in Supabase first.');
  console.error('cfo record action failed:', err && err.message);
  return httpError(500, 'Could not save. Try again.');
}

function buildRow(def, body) {
  const row = {};
  for (const field of def.fields) {
    const v = cleanValue(field, body[field.key]);
    if (v !== undefined) row[field.col] = v;
  }
  if (def.stamp) row[def.stamp] = new Date().toISOString();
  return row;
}

function idFrom(def, body) {
  const idCol = def.idColumn || 'id';
  const id = String(body.id === undefined || body.id === null ? '' : body.id).trim();
  if (!id) throw httpError(400, 'Which record?');
  if (idCol === 'id' && !UUID.test(id)) throw httpError(400, 'That is not a valid record.');
  if (id.length > 200) throw httpError(400, 'That is not a valid record.');
  return { idCol, id };
}

function defineRecords(defs) {
  const actions = {};
  for (const [key, def] of Object.entries(defs)) {
    actions[`save-${key}`] = async ({ supabase, body }) => {
      const row = buildRow(def, body || {});
      try {
        const query = def.conflict
          ? supabase.from(def.table).upsert(row, { onConflict: def.conflict })
          : supabase.from(def.table).insert(row);
        const { error } = await query;
        if (error) throw error;
      } catch (err) { throw explain(err); }
      return { saved: true };
    };

    actions[`delete-${key}`] = async ({ supabase, body }) => {
      const { idCol, id } = idFrom(def, body || {});
      try {
        const { error } = await supabase.from(def.table).delete().eq(idCol, id);
        if (error) throw error;
      } catch (err) { throw explain(err); }
      return { removed: true };
    };
  }
  return { actions };
}

// Small field builders so the definitions below stay readable.
const f = {
  text: (key, col, label, o = {}) => ({ key, col, label, type: 'text', ...o }),
  number: (key, col, label, o = {}) => ({ key, col, label, type: 'number', ...o }),
  date: (key, col, label, o = {}) => ({ key, col, label, type: 'date', ...o }),
  month: (key, col, label, o = {}) => ({ key, col, label, type: 'month', ...o }),
  enum: (key, col, label, values, o = {}) => ({ key, col, label, type: 'enum', values, ...o }),
};

/* ────────────────────────── the CFO's records ────────────────────────── */

const EXPENSE_CATEGORIES = [
  'Materials', 'Manufacturing', 'Salaries', 'Marketing', 'Shipping',
  'Rent and utilities', 'Software', 'Legal and compliance', 'Other',
];

const rec = defineRecords({
  'product-cost': {
    table: 'product_costs',
    idColumn: 'product_name',
    conflict: 'product_name',
    stamp: 'updated_at',
    fields: [
      f.text('productName', 'product_name', 'Product name', { required: true }),
      f.number('costPrice', 'cost_price', 'Cost price', { required: true, min: 0, max: 100000000 }),
      f.text('fabric', 'fabric', 'Fabric'),
      f.text('supplier', 'supplier', 'Supplier'),
    ],
  },
  expense: {
    table: 'expenses',
    fields: [
      f.date('spentOn', 'spent_on', 'Date', { required: true }),
      f.enum('category', 'category', 'Category', EXPENSE_CATEGORIES, { required: true }),
      f.text('description', 'description', 'Description'),
      f.number('amount', 'amount', 'Amount', { required: true, min: 0, max: 1000000000 }),
      f.text('paidTo', 'paid_to', 'Paid to'),
    ],
  },
  // Saving the same month + category again replaces the planned amount.
  budget: {
    table: 'budgets',
    conflict: 'month,category',
    fields: [
      f.month('month', 'month', 'Month', { required: true }),
      f.enum('category', 'category', 'Category', EXPENSE_CATEGORIES, { required: true }),
      f.number('planned', 'planned', 'Planned amount', { required: true, min: 0, max: 1000000000 }),
    ],
  },
  investment: {
    table: 'investments',
    fields: [
      f.text('name', 'name', 'Name', { required: true }),
      f.text('kind', 'kind', 'Kind (equipment, stock, deposit...)'),
      f.number('amount', 'amount', 'Amount put in', { required: true, min: 0, max: 1000000000 }),
      f.date('investedOn', 'invested_on', 'Invested on'),
      f.number('currentValue', 'current_value', 'Current value', { min: 0, max: 1000000000 }),
      f.text('notes', 'notes', 'Notes', { long: true }),
    ],
  },
  'tax-record': {
    table: 'tax_records',
    fields: [
      f.text('period', 'period', 'Period (e.g. Aug 2026)', { required: true }),
      f.text('taxType', 'tax_type', 'Tax type', { dbDefault: true }),
      f.number('collected', 'collected', 'Collected from customers', { min: 0, max: 1000000000, dbDefault: true }),
      f.number('paid', 'paid', 'Paid to government', { min: 0, max: 1000000000, dbDefault: true }),
      f.date('filedOn', 'filed_on', 'Filed on'),
      f.text('notes', 'notes', 'Notes', { long: true }),
    ],
  },
});

// Last N calendar months as 'YYYY-MM', oldest first.
function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/* ────────────────────────── module exports ────────────────────────── */

module.exports = {
  role: 'CFO',
  title: 'Chief Financial Officer',
  departments: ['Finance', 'Accounting', 'Budgeting', 'Taxation', 'Investment', 'Reporting'],
  notBuilt: [],
  actions: rec.actions,

  // `h` is passed in by the loader but deliberately not used here.
  async load({ supabase, getJSON }) {
    const [rows, marginData, expenses, budgets, investments, taxRecords, names] = await Promise.all([
      safe('cfo orders', () => fetchOrders(supabase)),
      safe('cfo margins', () => loadMargins(supabase, getJSON)),
      safe('cfo expenses', () => listRows(supabase, 'expenses', { order: 'spent_on', limit: 1000 })),
      safe('cfo budgets', () => listRows(supabase, 'budgets', { order: 'month', limit: 300 })),
      safe('cfo investments', () => listRows(supabase, 'investments', { order: 'created_at', limit: 100 })),
      safe('cfo tax', () => listRows(supabase, 'tax_records', { order: 'created_at', limit: 36 })),
      productNames(getJSON),
    ]);

    let orders = null;
    if (rows) {
      orders = {
        summary: summarizeOrders(rows),
        last7: windowRevenue(rows, 7, 0),
        prev7: windowRevenue(rows, 14, 7),
        last30: windowRevenue(rows, 30, 0),
        trend30: dailyTrend(rows, 30),
      };
    }

    // Ledger: revenue from paid orders against the expenses you entered.
    let ledger = null;
    if (rows && expenses) {
      ledger = lastMonths(6).map((month) => {
        const revenue = rows
          .filter((o) => PAID_STATUSES.includes(o.status) && String(o.created_at).slice(0, 7) === month)
          .reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const spent = expenses
          .filter((e) => String(e.spent_on).slice(0, 7) === month)
          .reduce((s, e) => s + (Number(e.amount) || 0), 0);
        return { month, revenue, expenses: spent, profit: revenue - spent };
      });
    }

    // Budget against actual spend, for the current month.
    let budgetsOut = null;
    if (budgets && expenses) {
      const month = todayISO().slice(0, 7);
      const lines = budgets
        .filter((b) => String(b.month).slice(0, 7) === month)
        .map((b) => {
          const actual = expenses
            .filter((e) => e.category === b.category && String(e.spent_on).slice(0, 7) === month)
            .reduce((s, e) => s + (Number(e.amount) || 0), 0);
          const planned = Number(b.planned) || 0;
          return { id: b.id, category: b.category, planned, actual, over: actual > planned };
        });
      budgetsOut = { month, lines, over: lines.filter((l) => l.over).length };
    }

    const investmentsOut = investments
      ? {
          invested: investments.reduce((s, i) => s + (Number(i.amount) || 0), 0),
          currentValue: investments.reduce((s, i) => s + (i.current_value == null ? Number(i.amount) || 0 : Number(i.current_value)), 0),
          list: investments.map((i) => ({
            id: i.id, name: i.name, kind: i.kind, amount: Number(i.amount) || 0,
            currentValue: i.current_value == null ? null : Number(i.current_value),
          })),
        }
      : null;

    const taxOut = taxRecords
      ? {
          collected: taxRecords.reduce((s, t) => s + (Number(t.collected) || 0), 0),
          paid: taxRecords.reduce((s, t) => s + (Number(t.paid) || 0), 0),
          unfiled: taxRecords.filter((t) => !t.filed_on).length,
          list: taxRecords.map((t) => ({
            id: t.id, period: t.period, type: t.tax_type, collected: Number(t.collected) || 0, paid: Number(t.paid) || 0, filedOn: t.filed_on,
          })),
        }
      : null;

    return {
      orders,
      margins: marginData ? marginData.margins : null,
      costs: marginData ? marginData.costs.slice(0, 40).map((c) => ({
        name: c.product_name, cost: Number(c.cost_price), fabric: c.fabric, supplier: c.supplier,
      })) : null,
      ledger,
      expenses: expenses ? {
        categories: EXPENSE_CATEGORIES,
        list: expenses.slice(0, 20).map((e) => ({
          id: e.id, date: e.spent_on, category: e.category, description: e.description, amount: Number(e.amount) || 0, paidTo: e.paid_to,
        })),
      } : { categories: EXPENSE_CATEGORIES, list: null },
      budgets: budgetsOut,
      investments: investmentsOut,
      tax: taxOut,
      productNames: names,
    };
  },
};
