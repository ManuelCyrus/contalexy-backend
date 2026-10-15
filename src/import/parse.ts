import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { DateOnly } from '../common/utils/dates';

export type RawTable = { columns: string[]; rows: string[][] };

/// Lê um CSV (separador detetado: , ; ou tab) ou um XLSX (primeira folha).
export async function readTable(buffer: Buffer, fileName: string): Promise<RawTable> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || buffer.subarray(0, 2).toString('ascii') === 'PK') return readXlsx(buffer);
  return readCsv(buffer);
}

function readCsv(buffer: Buffer): RawTable {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Alguns bancos exportam em latin1.
  if (/�/.test(text)) text = buffer.toString('latin1');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const delimiter = [';', ',', '\t', '|'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const records = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true }) as string[][];
  return tableFromRecords(records);
}

async function readXlsx(buffer: Buffer): Promise<RawTable> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { columns: [], rows: [] };
  const records: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let c = 1; c <= row.cellCount; c += 1) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v === null || v === undefined) values.push('');
      else if (v instanceof Date) values.push(v.toISOString().slice(0, 10));
      else if (typeof v === 'object' && 'result' in v) values.push(String((v as { result?: unknown }).result ?? ''));
      else if (typeof v === 'object' && 'richText' in v) values.push((v as { richText: { text: string }[] }).richText.map((r) => r.text).join(''));
      else if (typeof v === 'object' && 'text' in v) values.push(String((v as { text: string }).text));
      else values.push(String(v));
    }
    records.push(values);
  });
  return tableFromRecords(records);
}

/// A primeira linha com várias células de texto é o cabeçalho; antes dela
/// pode haver linhas de título do banco.
function tableFromRecords(records: string[][]): RawTable {
  const cleaned = records.map((r) => r.map((c) => (c ?? '').toString().trim())).filter((r) => r.some(Boolean));
  if (!cleaned.length) return { columns: [], rows: [] };
  let headerIndex = 0;
  for (let i = 0; i < Math.min(cleaned.length, 15); i += 1) {
    const r = cleaned[i];
    const texts = r.filter((c) => c && !parseAmount(c) && !parseDate(c)).length;
    if (r.filter(Boolean).length >= 2 && texts >= Math.ceil(r.filter(Boolean).length * 0.6)) {
      headerIndex = i;
      break;
    }
  }
  const width = Math.max(...cleaned.map((r) => r.length));
  const header = cleaned[headerIndex];
  const columns = Array.from({ length: width }, (_, i) => (header[i] && header[i].length <= 60 ? header[i] : `Coluna ${i + 1}`));
  const rows = cleaned.slice(headerIndex + 1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { columns, rows: rows.slice(0, 5000) };
}

/// "1.234,56", "1,234.56", "-12,50", "€ 12,50", "(12.50)" → número.
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d,.\-()]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-') || raw.trim().endsWith('-');
  s = s.replace(/[()\-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && s.indexOf(',') !== lastComma ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    if (decimals === 3 && s.indexOf('.') !== lastDot) s = s.replace(/\./g, '');
  }
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return Math.round((negative ? -value : value) * 100) / 100;
}

/// "2026-03-15", "15/03/2026", "15-03-2026", "15.03.2026", "3/15/2026", "15 mar 2026" → ISO.
export function parseDate(raw: string, preferMonthFirst = false): DateOnly | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12 && b <= 12) return build(y, b, a);
    if (b > 12 && a <= 12) return build(y, a, b);
    return preferMonthFirst ? build(y, a, b) : build(y, b, a);
  }
  const months: Record<string, number> = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
  m = s.toLowerCase().match(/^(\d{1,2})\s+([a-zç]{3})[a-zç]*\.?\s+(\d{4})/);
  if (m && months[m[2]]) return build(+m[3], months[m[2]], +m[1]);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /\d{4}/.test(s)) return d.toISOString().slice(0, 10);
  return null;
}

function build(y: number, mo: number, d: number): DateOnly | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface Mapping {
  date: number | null;
  amount: number | null;
  /// Em extratos com duas colunas: o que sai e o que entra
  debit: number | null;
  credit: number | null;
  description: number | null;
  merchant: number | null;
  category: number | null;
  /// true = os valores positivos são despesas (ex.: extratos de cartão)
  positiveIsExpense: boolean;
  monthFirst: boolean;
}

const DATE_WORDS = ['data', 'date', 'datum', 'dia', 'fecha', 'valor', 'movimento', 'lançamento'];
const AMOUNT_WORDS = ['montante', 'valor', 'amount', 'betrag', 'importe', 'quantia', 'total'];
const DEBIT_WORDS = ['débito', 'debito', 'debit', 'saída', 'saida', 'despesa', 'soll'];
const CREDIT_WORDS = ['crédito', 'credito', 'credit', 'entrada', 'receita', 'haben'];
const DESC_WORDS = ['descri', 'descrição', 'description', 'historico', 'histórico', 'memo', 'detalhe', 'details', 'verwendungszweck', 'concepto', 'narrative'];
const MERCHANT_WORDS = ['comerciante', 'merchant', 'payee', 'beneficiário', 'beneficiario', 'estabelecimento', 'empfänger'];
const CATEGORY_WORDS = ['categoria', 'category', 'kategorie', 'categoría'];

/// Adivinha o que é cada coluna pelo nome e pelo conteúdo.
export function guessMapping(table: RawTable): Mapping {
  const sample = table.rows.slice(0, 200);
  const n = table.columns.length;
  const score = (words: string[], name: string) => (words.some((w) => name.toLowerCase().includes(w)) ? 1 : 0);
  const ratio = (i: number, test: (v: string) => boolean) => (sample.length ? sample.filter((r) => r[i] && test(r[i])).length / sample.length : 0);
  const dateRatio = Array.from({ length: n }, (_, i) => ratio(i, (v) => !!parseDate(v)));
  const amountRatio = Array.from({ length: n }, (_, i) => ratio(i, (v) => parseAmount(v) !== null && !parseDate(v)));
  const textLen = Array.from({ length: n }, (_, i) => (sample.length ? sample.reduce((a, r) => a + (r[i]?.length ?? 0), 0) / sample.length : 0));
  const pick = (words: string[], base: number[], used: Set<number>, min = 0.5) => {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < n; i += 1) {
      if (used.has(i)) continue;
      const s = base[i] + score(words, table.columns[i]) * 0.6;
      if (base[i] >= min && s > bestScore) {
        best = i;
        bestScore = s;
      }
    }
    return best >= 0 ? best : null;
  };
  const used = new Set<number>();
  const date = pick(DATE_WORDS, dateRatio, used, 0.6);
  if (date !== null) used.add(date);
  // Duas colunas de valor (débito e crédito) ou uma só.
  let debit: number | null = null;
  let credit: number | null = null;
  let amount: number | null = null;
  const numeric = Array.from({ length: n }, (_, i) => i).filter((i) => !used.has(i) && amountRatio[i] >= 0.3);
  const debitCol = numeric.find((i) => score(DEBIT_WORDS, table.columns[i]));
  const creditCol = numeric.find((i) => score(CREDIT_WORDS, table.columns[i]) && i !== debitCol);
  if (debitCol !== undefined && creditCol !== undefined) {
    debit = debitCol;
    credit = creditCol;
    used.add(debit).add(credit);
  } else {
    amount = pick(AMOUNT_WORDS, amountRatio, used, 0.5);
    if (amount !== null) used.add(amount);
  }
  const textBase = textLen.map((l, i) => (used.has(i) || dateRatio[i] > 0.5 || amountRatio[i] > 0.5 ? 0 : Math.min(1, l / 12)));
  const description = pick(DESC_WORDS, textBase, used, 0.2);
  if (description !== null) used.add(description);
  const merchant = pick(MERCHANT_WORDS, textBase.map((v, i) => (score(MERCHANT_WORDS, table.columns[i]) ? v : 0)), used, 0.2);
  if (merchant !== null) used.add(merchant);
  const category = pick(CATEGORY_WORDS, textBase.map((v, i) => (score(CATEGORY_WORDS, table.columns[i]) ? v : 0)), used, 0.1);
  // Datas "m/d" só se alguma linha obrigar.
  const monthFirst = date !== null && sample.some((r) => /^(\d{1,2})[/.\-](\d{1,2})/.test(r[date] ?? '') && +(r[date].match(/^(\d{1,2})/)?.[1] ?? 0) <= 12 && +(r[date].match(/^\d{1,2}[/.\-](\d{1,2})/)?.[1] ?? 0) > 12);
  return { date, amount, debit, credit, description, merchant, category, positiveIsExpense: false, monthFirst };
}

/// Quão completa é a adivinha (0..1): com menos de 0,7 vale a pena pedir à IA.
export function mappingConfidence(m: Mapping): number {
  let s = 0;
  if (m.date !== null) s += 0.45;
  if (m.amount !== null || (m.debit !== null && m.credit !== null)) s += 0.4;
  if (m.description !== null) s += 0.15;
  return s;
}

export interface ParsedRow {
  index: number;
  date: DateOnly | null;
  amount: number | null;
  type: 'INCOME' | 'EXPENSE' | null;
  description: string | null;
  merchant: string | null;
  category: string | null;
  valid: boolean;
}

export function applyMapping(table: RawTable, m: Mapping): ParsedRow[] {
  return table.rows.map((r, index) => {
    const date = m.date !== null ? parseDate(r[m.date] ?? '', m.monthFirst) : null;
    let signed: number | null = null;
    if (m.amount !== null) signed = parseAmount(r[m.amount] ?? '');
    else if (m.debit !== null || m.credit !== null) {
      const d = m.debit !== null ? parseAmount(r[m.debit] ?? '') : null;
      const c = m.credit !== null ? parseAmount(r[m.credit] ?? '') : null;
      if (d !== null && d !== 0) signed = -Math.abs(d);
      else if (c !== null && c !== 0) signed = Math.abs(c);
    }
    if (signed !== null && m.positiveIsExpense) signed = -signed;
    const amount = signed === null ? null : Math.abs(signed);
    const type: 'INCOME' | 'EXPENSE' | null = signed === null ? null : signed >= 0 ? 'INCOME' : 'EXPENSE';
    const text = (i: number | null) => (i !== null && r[i] ? r[i].slice(0, 140) : null);
    return { index, date, amount, type, description: text(m.description), merchant: text(m.merchant) ? text(m.merchant)!.slice(0, 80) : null, category: text(m.category), valid: !!date && amount !== null && amount > 0 };
  });
}
