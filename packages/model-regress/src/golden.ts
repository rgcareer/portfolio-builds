// Deterministic golden set for the extraction task. Every item is rendered from fixed
// templates driven ONLY by mulberry32(seed), so the set is identical on every platform and
// the protocol can hash it without committing it. The expected output is computed by the
// generator (never hand-written), so the golden set is self-checking: total_cents is the
// sum of the line items, paid follows the payment phrase, and the ISO date is derived from
// the same (y,m,d) the prompt renders in one of four unambiguous human formats.

import { readFileSync } from 'node:fs';
import { mulberry32, sha256Canonical } from '@portfolio-builds/shared';

export interface GoldenLineItem {
  name: string;
  qty: number;
  unit_cents: number;
}

/** The canonical expected extraction for one item (the answer key). */
export interface GoldenExpected {
  id: string;
  date: string; // ISO YYYY-MM-DD
  total_cents: number; // Σ qty·unit_cents over items
  paid: boolean;
  status: string;
  items: GoldenLineItem[];
}

export type DateFormat = 'iso' | 'long-month' | 'day-month-year' | 'slash-ymd';

export interface GoldenItem {
  index: number;
  /** The user message the model extracts from (an invoice/work-order text). */
  prompt: string;
  /** Which of the four unambiguous date renderings this item used. */
  dateFormat: DateFormat;
  expected: GoldenExpected;
}

export interface GenerateGoldenParams {
  seed: number;
  n: number;
}

// Neutral goods/services — deliberately NOT personal names, so the set carries no PII.
const GOODS = [
  'Air filter',
  'Compressor unit',
  'Thermostat',
  'Refrigerant charge',
  'Labor',
  'Duct sealing',
  'Capacitor',
  'Blower motor',
  'Coil cleaning',
  'Service call',
] as const;

const STATUSES = ['open', 'closed', 'pending', 'complete', 'cancelled', 'in-progress'] as const;

const PAID_PHRASES = ['Payment received in full.', 'Paid in full.', 'Balance paid.', 'Invoice settled.'] as const;
const UNPAID_PHRASES = [
  'Payment not yet received.',
  'Balance outstanding.',
  'Unpaid at time of service.',
  'Awaiting payment.',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const DATE_FORMATS: DateFormat[] = ['iso', 'long-month', 'day-month-year', 'slash-ymd'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Render (y, m, d) in one of four formats whose mapping to ISO is unambiguous. */
function renderDate(y: number, m: number, d: number, fmt: DateFormat): string {
  switch (fmt) {
    case 'iso':
      return `${y}-${pad2(m)}-${pad2(d)}`;
    case 'long-month':
      return `${MONTHS_LONG[m - 1]} ${d}, ${y}`;
    case 'day-month-year':
      return `${d} ${MONTHS_ABBR[m - 1]} ${y}`;
    case 'slash-ymd':
      return `${y}/${pad2(m)}/${pad2(d)}`;
  }
}

export function generateGolden(params: GenerateGoldenParams): GoldenItem[] {
  const { seed, n } = params;
  const rng = mulberry32(seed);
  const int = (maxExclusive: number): number => Math.floor(rng() * maxExclusive);
  const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)]!;

  const items: GoldenItem[] = [];
  for (let i = 0; i < n; i++) {
    const id = `WO-${1000 + int(9000)}`;
    const year = 2024 + int(3); // 2024..2026
    const month = 1 + int(12); // 1..12
    const day = 1 + int(28); // 1..28 (always a valid calendar day)
    const fmt = DATE_FORMATS[int(DATE_FORMATS.length)]!;

    const numItems = 2 + int(3); // 2..4
    const lineItems: GoldenLineItem[] = [];
    for (let j = 0; j < numItems; j++) {
      const name = pick(GOODS);
      const qty = 1 + int(9); // 1..9
      const unit_cents = 100 * (1 + int(200)); // $1.00 .. $200.00, whole dollars
      lineItems.push({ name, qty, unit_cents });
    }
    const total_cents = lineItems.reduce((acc, li) => acc + li.qty * li.unit_cents, 0);

    const prevBalanceCents = 100 * (1 + int(1000)); // distractor, never part of the total
    const paid = int(2) === 1;
    const paymentPhrase = paid ? pick(PAID_PHRASES) : pick(UNPAID_PHRASES);
    const status = pick(STATUSES);

    const dateStr = renderDate(year, month, day, fmt);
    const isoDate = `${year}-${pad2(month)}-${pad2(day)}`;

    const lineLines = lineItems.map((li) => `- ${li.name} x${li.qty} @ ${li.unit_cents}c`).join('\n');
    const prompt =
      `Work Order ${id}\n` +
      `Date: ${dateStr}\n` +
      `Status: ${status}\n` +
      `Line items:\n${lineLines}\n` +
      `Previous balance: ${prevBalanceCents}c (already invoiced separately; do not include in the total)\n` +
      `${paymentPhrase}`;

    items.push({
      index: i,
      prompt,
      dateFormat: fmt,
      expected: { id, date: isoDate, total_cents, paid, status, items: lineItems },
    });
  }
  return items;
}

/** sha256 over the canonical serialization (order-independent). */
export function goldenHash(set: readonly GoldenItem[]): string {
  return sha256Canonical(set);
}

export class GoldenLoadError extends Error {}

export interface LoadGoldenOptions {
  /** When provided, the loaded set's hash must equal this or loading throws. */
  expectedHash?: string;
}

/** Load a committed golden set. With `expectedHash`, an edited file refuses to load. */
export function loadGolden(path: string, opts: LoadGoldenOptions = {}): GoldenItem[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as GoldenItem[];
  if (!Array.isArray(parsed)) throw new GoldenLoadError(`golden set at ${path} is not an array`);
  if (opts.expectedHash !== undefined) {
    const got = goldenHash(parsed);
    if (got !== opts.expectedHash) {
      throw new GoldenLoadError(
        `golden set at ${path} has hash ${got.slice(0, 16)}… but the protocol expects ${opts.expectedHash.slice(0, 16)}… (edited golden refuses to load)`,
      );
    }
  }
  return parsed;
}
