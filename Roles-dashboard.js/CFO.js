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
    case 'number':
    case 'int': {
      const n = Number(s);
      if (!Number.isFinite(n)) throw httpError(400, `${field.label} must be a number.`);
      if (field.type === 'int' && !Number.isInteger(n)) throw httpError(400, `${field.label} must be a whole number.`);
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
  int: (key, col, label, o = {}) => ({ key, col, label, type: 'int', ...o }),
  date: (key, col, label, o = {}) => ({ key, col, label, type: 'date', ...o }),
  month: (key, col, label, o = {}) => ({ key, col, label, type: 'month', ...o }),
  enum: (key, col, label, values, o = {}) => ({ key, col, label, type: 'enum', values, ...o }),
};

/* ────────────────────────── the CFO's records ────────────────────────── */

const EXPENSE_CATEGORIES = [
  'Materials', 'Manufacturing', 'Salaries', 'Marketing', 'Shipping',
  'Rent and utilities', 'Software', 'Legal and compliance', 'Other',
];

const ADJUSTMENT_KINDS = ['Interest', 'Tax', 'Depreciation'];
// Expense categories treated as cost of goods sold (everything else is operating expense).
const COGS_CATEGORIES = ['Materials', 'Manufacturing'];

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
  cash: {
    table: 'cash_balances',
    fields: [
      f.text('account', 'account', 'Account name', { required: true }),
      f.number('balance', 'balance', 'Balance', { required: true, min: -1000000000, max: 1000000000000 }),
      f.date('asOn', 'as_on', 'Balance as on', { required: true }),
    ],
  },
  receivable: {
    table: 'receivables',
    fields: [
      f.text('customer', 'customer', 'Customer', { required: true }),
      f.text('invoiceNo', 'invoice_no', 'Invoice number'),
      f.number('amount', 'amount', 'Amount', { required: true, min: 0, max: 1000000000000 }),
      f.date('invoiceDate', 'invoice_date', 'Invoice date'),
      f.date('dueDate', 'due_date', 'Due date', { required: true }),
    ],
  },
  payable: {
    table: 'payables',
    fields: [
      f.text('vendor', 'vendor', 'Vendor', { required: true }),
      f.text('billNo', 'bill_no', 'Bill number'),
      f.number('amount', 'amount', 'Amount', { required: true, min: 0, max: 1000000000000 }),
      f.date('billDate', 'bill_date', 'Bill date'),
      f.date('dueDate', 'due_date', 'Due date', { required: true }),
    ],
  },
  inventory: {
    table: 'inventory_snapshots',
    fields: [
      f.date('asOn', 'as_on', 'Stock value as on', { required: true }),
      f.number('value', 'value', 'Stock value', { required: true, min: 0, max: 1000000000000 }),
      f.text('notes', 'notes', 'Notes', { long: true }),
    ],
  },
  adjustment: {
    table: 'pnl_adjustments',
    fields: [
      f.month('month', 'month', 'Month', { required: true }),
      f.enum('kind', 'kind', 'Kind', ADJUSTMENT_KINDS, { required: true }),
      f.number('amount', 'amount', 'Amount', { required: true, min: 0, max: 1000000000000 }),
    ],
  },
  // One row per month; saving the same month again replaces its targets.
  target: {
    table: 'cfo_targets',
    conflict: 'month',
    fields: [
      f.month('month', 'month', 'Month', { required: true }),
      f.number('revenueTarget', 'revenue_target', 'Revenue target', { min: 0, max: 1000000000000 }),
      f.number('grossMarginTarget', 'gross_margin_target', 'Gross margin target (%)', { min: 0, max: 100 }),
      f.number('cacTarget', 'cac_target', 'CAC target', { min: 0, max: 1000000000 }),
      f.number('ltvTarget', 'ltv_target', 'LTV target', { min: 0, max: 1000000000 }),
      f.number('churnTarget', 'churn_target', 'Churn target (%)', { min: 0, max: 100 }),
      f.number('arpuTarget', 'arpu_target', 'ARPU target', { min: 0, max: 1000000000 }),
      f.number('customerTarget', 'customer_target', 'Customer count target', { min: 0, max: 1000000000 }),
    ],
  },
  'customer-metrics': {
    table: 'customer_metrics',
    conflict: 'month',
    fields: [
      f.month('month', 'month', 'Month', { required: true }),
      f.int('customers', 'customers', 'Total customers (end of month)', { required: true, min: 0, max: 1000000000 }),
      f.int('newCustomers', 'new_customers', 'New customers this month', { min: 0, max: 1000000000 }),
      f.int('churnedCustomers', 'churned_customers', 'Customers lost this month', { min: 0, max: 1000000000 }),
    ],
  },
  task: {
    table: 'cfo_tasks',
    fields: [
      f.text('title', 'title', 'Action', { required: true }),
      f.number('amount', 'amount', 'Amount involved', { min: 0, max: 1000000000000 }),
      f.enum('priority', 'priority', 'Priority', ['High', 'Medium', 'Low'], { required: true }),
      f.date('dueDate', 'due_date', 'Due date'),
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

/* ────────────────────────── one-off actions ────────────────────────── */

function idOnly(body) {
  const id = String((body && body.id) || '').trim();
  if (!UUID.test(id)) throw httpError(400, 'That is not a valid record.');
  return id;
}

function settle(table) {
  return async ({ supabase, body }) => {
    const id = idOnly(body);
    try {
      const { error } = await supabase.from(table).update({ status: 'paid', paid_on: todayISO() }).eq('id', id);
      if (error) throw error;
    } catch (err) { throw explain(err); }
    return { updated: true };
  };
}

const customActions = {
  'settle-receivable': settle('receivables'),
  'settle-payable': settle('payables'),
  'toggle-task': async ({ supabase, body }) => {
    const id = idOnly(body);
    const done = body.done === true || body.done === 'true';
    try {
      const { error } = await supabase.from('cfo_tasks').update({ done }).eq('id', id);
      if (error) throw error;
    } catch (err) { throw explain(err); }
    return { updated: true };
  },
};

/* ────────────────────────── module exports ────────────────────────── */

const monthKey = (v) => String(v || '').slice(0, 7);
const sum = (list, fn) => list.reduce((s, x) => s + (Number(fn(x)) || 0), 0);

// The one real query set behind both the dashboard (`load`) and the AI
// assistant (`assistantContext`) — same numbers everywhere, on purpose.
async function loadData({ supabase, getJSON }) {
    const [rows, marginData, expenses, budgets, investments, taxRecords, names,
      cash, receivables, payables, inventory, adjustments, targets, customerMetrics, tasks] = await Promise.all([
      safe('cfo orders', () => fetchOrders(supabase)),
      safe('cfo margins', () => loadMargins(supabase, getJSON)),
      safe('cfo expenses', () => listRows(supabase, 'expenses', { order: 'spent_on', limit: 1000 })),
      safe('cfo budgets', () => listRows(supabase, 'budgets', { order: 'month', limit: 300 })),
      safe('cfo investments', () => listRows(supabase, 'investments', { order: 'created_at', limit: 100 })),
      safe('cfo tax', () => listRows(supabase, 'tax_records', { order: 'created_at', limit: 36 })),
      productNames(getJSON),
      safe('cfo cash', () => listRows(supabase, 'cash_balances', { order: 'as_on', limit: 300 })),
      safe('cfo receivables', () => listRows(supabase, 'receivables', { order: 'due_date', ascending: true, limit: 500 })),
      safe('cfo payables', () => listRows(supabase, 'payables', { order: 'due_date', ascending: true, limit: 500 })),
      safe('cfo inventory', () => listRows(supabase, 'inventory_snapshots', { order: 'as_on', limit: 60 })),
      safe('cfo adjustments', () => listRows(supabase, 'pnl_adjustments', { order: 'month', limit: 300 })),
      safe('cfo targets', () => listRows(supabase, 'cfo_targets', { order: 'month', limit: 60 })),
      safe('cfo customers', () => listRows(supabase, 'customer_metrics', { order: 'month', limit: 60 })),
      safe('cfo tasks', () => listRows(supabase, 'cfo_tasks', { order: 'created_at', limit: 200 })),
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

    // One row per calendar month (oldest first, current month last): the
    // single source the page uses for trends, P&L, cash flow and forecast.
    let monthly = null;
    if (rows && expenses) {
      const buckets = new Map(lastMonths(18).map((month) => [month, {
        month, revenue: 0, orders: 0, cogs: 0, opex: 0, byCategory: {},
        interest: 0, tax: 0, depreciation: 0, invested: 0,
      }]));
      for (const o of rows) {
        if (!PAID_STATUSES.includes(o.status)) continue;
        const b = buckets.get(monthKey(o.created_at));
        if (b) { b.revenue += Number(o.amount) || 0; b.orders += 1; }
      }
      for (const e of expenses) {
        const b = buckets.get(monthKey(e.spent_on));
        if (!b) continue;
        const amt = Number(e.amount) || 0;
        b.byCategory[e.category] = (b.byCategory[e.category] || 0) + amt;
        if (COGS_CATEGORIES.includes(e.category)) b.cogs += amt; else b.opex += amt;
      }
      for (const a of adjustments || []) {
        const b = buckets.get(monthKey(a.month));
        if (b) b[String(a.kind).toLowerCase()] += Number(a.amount) || 0;
      }
      for (const i of investments || []) {
        const b = buckets.get(monthKey(i.invested_on || i.created_at));
        if (b) b.invested += Number(i.amount) || 0;
      }
      monthly = [...buckets.values()];
    }

    // Budget against actual spend, for the current month.
    let budgetsOut = null;
    if (budgets && expenses) {
      const month = todayISO().slice(0, 7);
      const lines = budgets
        .filter((b) => monthKey(b.month) === month)
        .map((b) => {
          const actual = sum(expenses.filter((e) => e.category === b.category && monthKey(e.spent_on) === month), (e) => e.amount);
          const planned = Number(b.planned) || 0;
          return { id: b.id, category: b.category, planned, actual, over: actual > planned };
        });
      budgetsOut = { month, lines, over: lines.filter((l) => l.over).length };
    }

    const investmentsOut = investments
      ? {
          invested: sum(investments, (i) => i.amount),
          currentValue: sum(investments, (i) => (i.current_value == null ? i.amount : i.current_value)),
          list: investments.map((i) => ({
            id: i.id, name: i.name, kind: i.kind, amount: Number(i.amount) || 0,
            currentValue: i.current_value == null ? null : Number(i.current_value),
          })),
        }
      : null;

    const taxOut = taxRecords
      ? {
          collected: sum(taxRecords, (t) => t.collected),
          paid: sum(taxRecords, (t) => t.paid),
          unfiled: taxRecords.filter((t) => !t.filed_on).length,
          list: taxRecords.map((t) => ({
            id: t.id, period: t.period, type: t.tax_type, collected: Number(t.collected) || 0, paid: Number(t.paid) || 0, filedOn: t.filed_on,
          })),
        }
      : null;

    return {
      asOf: todayISO(),
      orders,
      monthly,
      margins: marginData ? marginData.margins : null,
      costs: marginData ? marginData.costs.slice(0, 40).map((c) => ({
        name: c.product_name, cost: Number(c.cost_price), fabric: c.fabric, supplier: c.supplier,
      })) : null,
      expenses: expenses ? {
        categories: EXPENSE_CATEGORIES,
        cogsCategories: COGS_CATEGORIES,
        list: expenses.map((e) => ({
          id: e.id, date: e.spent_on, category: e.category, description: e.description, amount: Number(e.amount) || 0, paidTo: e.paid_to,
        })),
      } : null,
      budgets: budgetsOut,
      budgetRows: budgets ? budgets.map((b) => ({ id: b.id, month: monthKey(b.month), category: b.category, planned: Number(b.planned) || 0 })) : null,
      investments: investmentsOut,
      tax: taxOut,
      cash: cash ? cash.map((c) => ({ id: c.id, account: c.account, balance: Number(c.balance) || 0, asOn: String(c.as_on).slice(0, 10) })) : null,
      receivables: receivables ? receivables.map((r) => ({
        id: r.id, customer: r.customer, invoiceNo: r.invoice_no, amount: Number(r.amount) || 0,
        invoiceDate: r.invoice_date, dueDate: String(r.due_date).slice(0, 10), status: r.status, paidOn: r.paid_on,
      })) : null,
      payables: payables ? payables.map((r) => ({
        id: r.id, vendor: r.vendor, billNo: r.bill_no, amount: Number(r.amount) || 0,
        billDate: r.bill_date, dueDate: String(r.due_date).slice(0, 10), status: r.status, paidOn: r.paid_on,
      })) : null,
      inventory: inventory ? inventory.map((r) => ({ id: r.id, asOn: String(r.as_on).slice(0, 10), value: Number(r.value) || 0, notes: r.notes })) : null,
      adjustments: adjustments ? adjustments.map((a) => ({ id: a.id, month: monthKey(a.month), kind: a.kind, amount: Number(a.amount) || 0 })) : null,
      targets: targets ? targets.map((t) => ({
        id: t.id, month: monthKey(t.month),
        revenueTarget: t.revenue_target == null ? null : Number(t.revenue_target),
        grossMarginTarget: t.gross_margin_target == null ? null : Number(t.gross_margin_target),
        cacTarget: t.cac_target == null ? null : Number(t.cac_target),
        ltvTarget: t.ltv_target == null ? null : Number(t.ltv_target),
        churnTarget: t.churn_target == null ? null : Number(t.churn_target),
        arpuTarget: t.arpu_target == null ? null : Number(t.arpu_target),
        customerTarget: t.customer_target == null ? null : Number(t.customer_target),
      })) : null,
      customerMetrics: customerMetrics ? customerMetrics.map((c) => ({
        id: c.id, month: monthKey(c.month), customers: Number(c.customers) || 0,
        newCustomers: c.new_customers == null ? null : Number(c.new_customers),
        churnedCustomers: c.churned_customers == null ? null : Number(c.churned_customers),
      })) : null,
      tasks: tasks ? tasks.map((t) => ({
        id: t.id, title: t.title, amount: t.amount == null ? null : Number(t.amount), priority: t.priority, dueDate: t.due_date, done: !!t.done,
      })) : null,
      productNames: names,
    };
}

/* ────────────────────────── AI assistant (Gemini, via api/admin.js) ──────────────────────────
   Same loadData() as the dashboard — the assistant is never shown a number
   the CFO can't also see on their own page. Two pieces:
   - text: a short always-on brief for the system prompt (cheap, no tool call needed).
   - snapshot: a fuller JSON object, returned only when the assistant calls the
     getCfoFinancials tool — kept well short of Gemini's context limits by
     trimming lists to what a CFO would actually ask about (recent months,
     the top overdue items, current budgets). */

const INR = (n) => '\u20b9' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const PCT = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);

// Same P&L math as the dashboard's client-side `decorate()` — kept in sync
// by hand since one runs in the browser and one on the server.
function decorateMonth(m) {
  const cogs = m.cogs, opex = m.opex, gross = m.revenue - cogs, ebitda = gross - opex;
  const net = ebitda - (m.interest + m.tax + m.depreciation);
  return { ...m, gross, ebitda, net };
}

function agingSummary(list) {
  if (!list) return null;
  const today = todayISO();
  const open = list.filter((r) => r.status !== 'paid');
  let overdue = 0, overdueCount = 0;
  const items = open.map((r) => {
    const lateDays = Math.round((Date.parse(today) - Date.parse(String(r.dueDate).slice(0, 10))) / DAY);
    if (lateDays > 0) { overdue += r.amount; overdueCount += 1; }
    return { ...r, lateDays };
  }).sort((a, b) => b.lateDays - a.lateDays);
  return { total: sum(open, (r) => r.amount), overdue, overdueCount, openCount: open.length, top: items.slice(0, 10) };
}

async function assistantBrief({ supabase, getJSON }) {
  const d = await loadData({ supabase, getJSON });

  if (!d.monthly) {
    return {
      text: `Razariser's CFO dashboard could not load order/expense data just now (a query failed). Do not invent revenue, margin, or cash figures — tell the admin to check the CFO dashboard directly, or try again.`,
      snapshot: { error: 'order/expense data unavailable' },
    };
  }

  const cur = d.monthly[d.monthly.length - 1], pm = d.monthly[d.monthly.length - 2] || null;
  const c = decorateMonth(cur), p = pm ? decorateMonth(pm) : null;
  const gm = c.revenue > 0 && c.cogs > 0 ? PCT((c.gross / c.revenue) * 100) : null;

  const cashTotal = d.cash && d.cash.length ? (() => {
    const by = {}; d.cash.forEach((e) => { if (!by[e.account] || e.asOn > by[e.account].asOn) by[e.account] = e; });
    return sum(Object.values(by), (e) => e.balance);
  })() : null;

  const ar = agingSummary(d.receivables), ap = agingSummary(d.payables);
  const target = d.targets && d.targets.length ? d.targets.filter((t) => t.month <= c.month).sort((a, b) => (a.month < b.month ? 1 : -1))[0] : null;
  const budgetTotal = d.budgetRows ? sum(d.budgetRows.filter((b) => b.month === c.month), (b) => b.planned) : 0;

  const lines = [
    `As of ${d.asOf}, this month (${c.month}) vs last month:`,
    `- Revenue: ${INR(c.revenue)}${p ? ` (was ${INR(p.revenue)})` : ''}, from ${c.orders} paid orders.`,
    `- Cost of goods sold: ${INR(c.cogs)}. Operating expenses: ${INR(c.opex)}.`,
    `- Gross profit: ${INR(c.gross)}${gm != null ? ` (${gm}% margin)` : ' (margin unknown \u2014 no Materials/Manufacturing expenses logged yet)'}.`,
    `- EBITDA: ${INR(c.ebitda)}. Net profit (after interest, tax, depreciation): ${INR(c.net)}.`,
    target && target.revenueTarget ? `- Revenue target this month: ${INR(target.revenueTarget)} (${PCT((c.revenue / target.revenueTarget) * 100)}% achieved so far).` : '- No revenue target set for this month.',
    d.cash ? `- Cash & bank balance: ${cashTotal == null ? 'no balance entered yet' : INR(cashTotal)}.` : '- Cash balance data unavailable.',
    budgetTotal ? `- Budget this month: ${INR(budgetTotal)} planned vs ${INR(c.cogs + c.opex)} actual spend${d.budgets && d.budgets.over ? `, ${d.budgets.over} categor${d.budgets.over === 1 ? 'y is' : 'ies are'} over` : ''}.` : '- No budget set for this month.',
    ar ? `- Receivables: ${INR(ar.total)} outstanding across ${ar.openCount} open invoice(s), ${INR(ar.overdue)} of that is overdue (${ar.overdueCount}).` : '- No receivables tracked.',
    ap ? `- Payables: ${INR(ap.total)} outstanding across ${ap.openCount} open bill(s), ${INR(ap.overdue)} of that is overdue (${ap.overdueCount}).` : '- No payables tracked.',
    d.tax ? `- Tax: ${INR(d.tax.collected)} collected, ${INR(d.tax.paid)} paid, ${d.tax.unfiled} period(s) not filed.` : '- No tax records.',
    d.investments ? `- Investments: ${INR(d.investments.invested)} invested, currently valued at ${INR(d.investments.currentValue)}.` : '- No investments tracked.',
    `Call the getCfoFinancials tool for the last several months of P&L, the full budget breakdown, or the oldest overdue receivables/payables by name \u2014 this summary only covers the current month.`,
  ];

  const snapshot = {
    asOf: d.asOf,
    monthlyPnL: d.monthly.slice(-6).map((m) => { const x = decorateMonth(m); return { month: x.month, revenue: x.revenue, orders: x.orders, cogs: x.cogs, opex: x.opex, gross: x.gross, ebitda: x.ebitda, net: x.net }; }),
    budget: d.budgets,
    cashByAccount: d.cash ? (() => { const by = {}; d.cash.forEach((e) => { if (!by[e.account] || e.asOn > by[e.account].asOn) by[e.account] = e; }); return Object.values(by); })() : null,
    receivablesAging: ar ? { total: ar.total, overdue: ar.overdue, overdueCount: ar.overdueCount, openCount: ar.openCount, oldestOpen: ar.top } : null,
    payablesAging: ap ? { total: ap.total, overdue: ap.overdue, overdueCount: ap.overdueCount, openCount: ap.openCount, oldestOpen: ap.top } : null,
    targets: d.targets,
    investments: d.investments,
    tax: d.tax,
    margins: d.margins,
    openTasks: d.tasks ? d.tasks.filter((t) => !t.done).slice(0, 15) : null,
    recentExpenses: d.expenses && d.expenses.list ? d.expenses.list.slice(0, 15) : null,
  };

  return { text: lines.join('\n'), snapshot };
}

/* ────────────────────────── module exports ────────────────────────── */

module.exports = {
  role: 'CFO',
  title: 'Chief Financial Officer',
  departments: ['Finance', 'Accounting', 'Budgeting', 'Taxation', 'Investment', 'Reporting'],
  notBuilt: [],
  actions: { ...rec.actions, ...customActions },
  load: loadData,
  assistantBrief,
};
