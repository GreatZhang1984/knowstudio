/**
 * 逐表 DDL 结构比对器（DoD②：SHOW CREATE TABLE 与架构 §4.4 逐表比对）。
 *
 * 为什么不能直接字符串比对：MySQL 的 SHOW CREATE TABLE 会做一连串**渲染变换**，
 * 源 DDL 与回显几乎不可能逐字节相同。已实测到的变换（全部来自本实例 8.4.13）：
 *   1. 所有标识符加反引号；类型/关键字转小写
 *   2. 可空且无显式默认值的列补 `DEFAULT NULL`
 *   3. 数值默认值加引号：`DEFAULT 0` → `DEFAULT '0'`；`TRUE/FALSE` → `'1'/'0'`
 *   4. 字符串字面量前加字符集引导符：`'x'` → `_utf8mb4'x'`
 *   5. `col->'$.p'` 重写为 `json_extract(col,'$.p')`；`->>` 再套 json_unquote
 *   6. FULLTEXT 的 `WITH PARSER ngram` 被包进版本门注释（以 `/*!50100` 开头的那种）
 *   7. CHECK / 生成列表达式补大量冗余括号，运算符转小写
 *   8. 整型显示宽度被丢弃：`INT` → `int`（`tinyint(1)` 保留，因它是 BOOL 语义）
 *   9. 列级 charset/collate 等于表默认时被省略
 *  10. 空表不显示 `AUTO_INCREMENT=N` 计数器
 *
 * 策略：**两侧都过同一个规范化器**，再逐项比对。这样渲染差异被消掉，
 * 而真实语义差异（类型/长度/可空/默认/索引列/约束表达式/FK 动作）一定留下。
 * 规范化只做上面这 10 类「已知渲染变换」，不做任何「忽略差异」的兜底。
 *
 * 可信度靠负向验证保证：test/ddl-compare.test.ts 会故意扰动真实 DDL
 * （改长度、删 CHECK、改 collation、改 FK 动作、改生成列表达式），
 * 断言比对器**必须**报差异——防止规范化过度导致「假绿」。
 */

// ── 词法 ─────────────────────────────────────────────────────────────────────

type TokKind = 'id' | 'str' | 'num' | 'p';
interface Tok {
  readonly k: TokKind;
  readonly t: string;
  /** 是否被反引号包裹。被包裹的一定是标识符，绝不可能是关键字（列名 `key` 靠它区分）。 */
  readonly q?: boolean;
}

const MULTI_OPS = ['->>', '->', '<=', '>=', '<>', '!=', '||'];

/** 词法分析。注释在此处理：`--`/`#`/普通块注释丢弃，版本门注释（以 `/*!NNNNN` 开头）解包保留内容。 */
export function lex(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = input.length;

  const pushIdent = (raw: string, quoted = false): void => {
    out.push(quoted ? { k: 'id', t: raw.toLowerCase(), q: true } : { k: 'id', t: raw.toLowerCase() });
  };

  while (i < n) {
    const c = input[i] as string;

    // 空白
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    // 行注释：MySQL 要求 `--` 后跟空白或行尾
    if (c === '-' && input[i + 1] === '-' && (input[i + 2] === undefined || /[\s]/.test(input[i + 2] as string))) {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (c === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const body = input.slice(i + 2, end === -1 ? n : end);
      if (/^!\d*/.test(body)) {
        // 版本门注释：内容是真实 DDL 的一部分，必须保留
        out.push(...lex(body.replace(/^!\d*\s*/, '')));
      }
      i = stop;
      continue;
    }
    // 反引号标识符
    if (c === '`') {
      let j = i + 1;
      let buf = '';
      while (j < n) {
        if (input[j] === '`') {
          if (input[j + 1] === '`') {
            buf += '`';
            j += 2;
            continue;
          }
          break;
        }
        buf += input[j];
        j += 1;
      }
      pushIdent(buf, true);
      i = j + 1;
      continue;
    }
    // 字符串字面量（单/双引号，支持反斜杠转义与双写转义）
    if (c === "'" || c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n) {
        const ch = input[j] as string;
        if (ch === '\\' && j + 1 < n) {
          buf += ch + (input[j + 1] as string);
          j += 2;
          continue;
        }
        if (ch === c) {
          if (input[j + 1] === c) {
            buf += c + c;
            j += 2;
            continue;
          }
          break;
        }
        buf += ch;
        j += 1;
      }
      out.push({ k: 'str', t: `'${buf.replace(/^"|"$/g, '')}'` });
      i = j + 1;
      continue;
    }
    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(input[j] as string)) {
        // 指数符号只有在紧跟 e/E 时才算数字的一部分
        if (((input[j] === '+' || input[j] === '-') && !/[eE]/.test(input[j - 1] ?? '')) || (input[j] === '.' && input.slice(i, j).includes('.'))) break;
        j += 1;
      }
      out.push({ k: 'num', t: input.slice(i, j) });
      i = j;
      continue;
    }
    // 多字符运算符
    const op = MULTI_OPS.find((o) => input.startsWith(o, i));
    if (op !== undefined) {
      out.push({ k: 'p', t: op });
      i += op.length;
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(input[j] as string)) j += 1;
      pushIdent(input.slice(i, j));
      i = j;
      continue;
    }
    out.push({ k: 'p', t: c });
    i += 1;
  }
  return out;
}

// ── 表达式规范化（最小括号 + 统一字面量） ──────────────────────────────────────

/** 优先级：数字越大绑定越紧。渲染时子节点优先级低于父节点才加括号。 */
const PREC: Record<string, number> = {
  or: 1,
  '||': 1,
  and: 2,
  not: 3,
  '=': 4,
  '<>': 4,
  '!=': 4,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  is: 4,
  in: 4,
  between: 4,
  like: 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

interface Node {
  readonly text: string;
  readonly prec: number;
}

const ATOM = 8;

class ExprParser {
  private pos = 0;
  constructor(private readonly toks: readonly Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private at(t: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.t === t && tok.k !== 'str';
  }
  private take(): Tok {
    const tok = this.toks[this.pos];
    if (tok === undefined) throw new Error('表达式意外结束');
    this.pos += 1;
    return tok;
  }
  private expect(t: string): void {
    const tok = this.take();
    if (tok.t !== t || tok.k === 'str') throw new Error(`期望 ${t}，实际 ${tok.t}`);
  }
  done(): boolean {
    return this.pos >= this.toks.length;
  }

  /** 字面量规范化：数值去引号、TRUE/FALSE → 1/0、字符集引导符已在预处理剥离。 */
  private literal(tok: Tok): Node {
    if (tok.k === 'num') return { text: tok.t, prec: ATOM };
    if (tok.k === 'str') {
      const inner = tok.t.slice(1, -1);
      if (/^-?\d+(?:\.\d+)?$/.test(inner)) return { text: inner, prec: ATOM };
      return { text: tok.t, prec: ATOM };
    }
    if (tok.t === 'true') return { text: '1', prec: ATOM };
    if (tok.t === 'false') return { text: '0', prec: ATOM };
    if (tok.t === 'null') return { text: 'null', prec: ATOM };
    return { text: tok.t, prec: ATOM };
  }

  private atom(): Node {
    const tok = this.peek();
    if (tok === undefined) throw new Error('表达式缺少原子项');

    if (tok.k === 'p' && tok.t === '(') {
      this.take();
      const inner = this.parse(1);
      this.expect(')');
      // 括号本身不产生优先级：冗余括号在此自然消解
      return inner;
    }
    if (tok.k === 'p' && tok.t === '-') {
      this.take();
      const operand = this.parse(7);
      return { text: `-${wrap(operand, 7)}`, prec: 7 };
    }
    if (tok.k === 'id' && tok.t === 'not') {
      this.take();
      return { text: `not ${wrap(this.parse(3), 3)}`, prec: 3 };
    }
    if (tok.k === 'id' && (tok.t === 'cast' || tok.t === 'convert')) {
      return this.castLike();
    }
    if (tok.k === 'id' && tok.t === 'interval') {
      this.take();
      const v = this.parse(ATOM);
      const unit = this.take();
      return { text: `interval ${v.text} ${unit.t}`, prec: ATOM };
    }
    // 函数调用
    if (tok.k === 'id' && this.toks[this.pos + 1]?.t === '(' && this.toks[this.pos + 1]?.k === 'p') {
      const name = this.take().t;
      this.expect('(');
      const args: string[] = [];
      if (!this.at(')')) {
        for (;;) {
          args.push(this.parse(1).text);
          if (this.at(',')) {
            this.take();
            continue;
          }
          break;
        }
      }
      this.expect(')');
      return { text: `${name}(${args.join(',')})`, prec: ATOM };
    }
    return this.literal(this.take());
  }

  /** CAST(expr AS type [ARRAY])：type 不是表达式，按原样收集到匹配右括号。 */
  private castLike(): Node {
    const name = this.take().t;
    this.expect('(');
    const inner = this.parse(1);
    this.expect('as');
    const parts: string[] = [];
    let depth = 0;
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) throw new Error('CAST 缺少右括号');
      if (tok.k === 'p' && tok.t === ')' && depth === 0) break;
      if (tok.k === 'p' && tok.t === '(') depth += 1;
      if (tok.k === 'p' && tok.t === ')') depth -= 1;
      parts.push(this.take().t);
    }
    this.expect(')');
    return { text: `${name}(${inner.text} as ${tightenType(parts)})`, prec: ATOM };
  }

  parse(minPrec: number): Node {
    let left = this.atom();
    for (;;) {
      const tok = this.peek();
      if (tok === undefined || tok.k === 'str' || tok.k === 'num') break;
      const op = tok.t;

      // 后缀：IS [NOT] NULL / IS [NOT] TRUE ...
      if (op === 'is') {
        if (PREC['is']! < minPrec) break;
        this.take();
        let neg = '';
        if (this.at('not')) {
          this.take();
          neg = 'not ';
        }
        const rhs = this.take();
        left = { text: `${wrap(left, 4)} is ${neg}${rhs.t}`, prec: 4 };
        continue;
      }
      // IN (list)
      if (op === 'in') {
        if (PREC['in']! < minPrec) break;
        this.take();
        this.expect('(');
        const items: string[] = [];
        if (!this.at(')')) {
          for (;;) {
            items.push(this.parse(1).text);
            if (this.at(',')) {
              this.take();
              continue;
            }
            break;
          }
        }
        this.expect(')');
        left = { text: `${wrap(left, 4)} in (${items.join(',')})`, prec: 4 };
        continue;
      }
      // BETWEEN a AND b
      if (op === 'between') {
        if (PREC['between']! < minPrec) break;
        this.take();
        let neg = '';
        if (this.at('not')) {
          this.take();
          neg = 'not ';
        }
        const lo = this.parse(5);
        this.expect('and');
        const hi = this.parse(5);
        left = { text: `${wrap(left, 4)} ${neg}between ${lo.text} and ${hi.text}`, prec: 4 };
        continue;
      }
      if (op === 'not') {
        // NOT IN / NOT BETWEEN / NOT LIKE
        const next = this.toks[this.pos + 1]?.t;
        if (next === 'in' || next === 'between' || next === 'like') {
          if (4 < minPrec) break;
          this.take();
          const saved = this.pos;
          // 复用上面的分支：把 not 折进渲染
          const inner = this.parse(4);
          this.pos = saved;
          void inner;
          const opTok = this.take().t;
          if (opTok === 'in') {
            this.expect('(');
            const items: string[] = [];
            if (!this.at(')')) {
              for (;;) {
                items.push(this.parse(1).text);
                if (this.at(',')) {
                  this.take();
                  continue;
                }
                break;
              }
            }
            this.expect(')');
            left = { text: `${wrap(left, 4)} not in (${items.join(',')})`, prec: 4 };
          } else if (opTok === 'between') {
            const lo = this.parse(5);
            this.expect('and');
            const hi = this.parse(5);
            left = { text: `${wrap(left, 4)} not between ${lo.text} and ${hi.text}`, prec: 4 };
          } else {
            const rhs = this.parse(5);
            left = { text: `${wrap(left, 4)} not like ${rhs.text}`, prec: 4 };
          }
          continue;
        }
        break;
      }

      const prec = PREC[op];
      if (prec === undefined || prec < minPrec) break;
      this.take();
      const right = this.parse(prec + 1);
      const normalizedOp = op === '!=' ? '<>' : op === '||' ? 'or' : op;
      left = { text: `${wrap(left, prec)} ${normalizedOp} ${wrap(right, prec + 1)}`, prec };
    }
    return left;
  }
}

function wrap(node: Node, minPrec: number): string {
  return node.prec < minPrec ? `(${node.text})` : node.text;
}

/** 类型 token 拼接：括号与逗号两侧不留空格（CHAR(64) ARRAY / DECIMAL(3,2)）。 */
function tightenType(parts: readonly string[]): string {
  return parts
    .join(' ')
    .replace(/\s+\(/g, '(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+,/g, ',')
    .replace(/,\s+/g, ',');
}

/** 预处理：剥离字符集引导符、把 `->` / `->>` 重写为 JSON 函数调用。 */
function preprocess(toks: readonly Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i] as Tok;
    // _utf8mb4'x' / _ascii'x' → 'x'
    if (tok.k === 'id' && /^_[a-z0-9]+$/.test(tok.t) && toks[i + 1]?.k === 'str') {
      continue;
    }
    if (tok.k === 'p' && (tok.t === '->' || tok.t === '->>')) {
      const path = toks[i + 1];
      const base = out.pop();
      if (path === undefined || base === undefined) throw new Error('-> 运算符缺少操作数');
      const inner: Tok[] = [
        { k: 'id', t: 'json_extract' },
        { k: 'p', t: '(' },
        base,
        { k: 'p', t: ',' },
        path,
        { k: 'p', t: ')' },
      ];
      if (tok.t === '->>') {
        out.push({ k: 'id', t: 'json_unquote' }, { k: 'p', t: '(' }, ...inner, { k: 'p', t: ')' });
      } else {
        out.push(...inner);
      }
      i += 1;
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** 规范化一段表达式为最小括号形式。 */
export function canonicalExpr(input: string | readonly Tok[]): string {
  const toks = preprocess(typeof input === 'string' ? lex(input) : input);
  if (toks.length === 0) return '';
  const parser = new ExprParser(toks);
  const node = parser.parse(1);
  if (!parser.done()) throw new Error(`表达式有剩余 token：${toks.map((t) => t.t).join(' ')}`);
  return node.text;
}

// ── 类型与列定义规范化 ────────────────────────────────────────────────────────

const TYPE_ALIAS: Record<string, string> = {
  integer: 'int',
  bool: 'tinyint(1)',
  boolean: 'tinyint(1)',
  dec: 'decimal',
  numeric: 'decimal',
  'double precision': 'double',
  real: 'double',
};

/** 整型显示宽度在 8.0.17+ 被废弃；tinyint(1) 例外（BOOL 语义，MySQL 会保留）。 */
function canonicalType(toks: readonly Tok[], start: number): { text: string; next: number } {
  let i = start;
  const first = toks[i];
  if (first === undefined) throw new Error('列定义缺少类型');
  let name = first.t;
  i += 1;

  // 多词类型
  if (name === 'double' && toks[i]?.t === 'precision') {
    name = 'double precision';
    i += 1;
  }
  const alias = TYPE_ALIAS[name];
  if (alias !== undefined) {
    // tinyint(1) 这类别名自带长度，不再消费后面的括号
    if (alias.includes('(')) return { text: alias, next: i };
    name = alias;
  }

  let text = name;
  // 长度/精度
  if (toks[i]?.k === 'p' && toks[i]?.t === '(') {
    let depth = 0;
    const parts: string[] = [];
    for (;;) {
      const tok = toks[i];
      if (tok === undefined) throw new Error('类型括号未闭合');
      i += 1;
      if (tok.t === '(') {
        depth += 1;
        if (depth === 1) continue;
      }
      if (tok.t === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (tok.t !== ',') parts.push(tok.t);
    }
    const inner = parts.join(',');
    const isInt = /^(tinyint|smallint|mediumint|int|bigint)$/.test(name);
    // 整型显示宽度丢弃；tinyint(1) 保留
    if (!(isInt && !(name === 'tinyint' && inner === '1'))) {
      text += `(${inner})`;
    }
  }
  // unsigned / zerofill
  while (toks[i]?.t === 'unsigned' || toks[i]?.t === 'zerofill') {
    text += ` ${toks[i]?.t ?? ''}`;
    i += 1;
  }
  return { text, next: i };
}

export interface ColumnShape {
  readonly name: string;
  readonly canonical: string;
}

export interface ForeignKeyShape {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface TableShape {
  readonly name: string;
  readonly columns: readonly ColumnShape[];
  /** 索引（含 PRIMARY/UNIQUE/FULLTEXT/多值），已排序，与声明顺序无关。 */
  readonly keys: readonly string[];
  /** CHECK / FOREIGN KEY 约束，已排序。 */
  readonly constraints: readonly string[];
  /** 声明的外键，用于识别 MySQL 自动补建的 FK 索引。 */
  readonly foreignKeys: readonly ForeignKeyShape[];
  readonly options: string;
}

const KEY_STARTERS = ['primary', 'unique', 'key', 'index', 'fulltext', 'spatial', 'constraint', 'foreign'];

/**
 * 抽取外键名与列。形态：CONSTRAINT name FOREIGN KEY (cols) REFERENCES ...
 * MySQL 会为「没有可用索引」的 FK 列自动建索引，索引名 = 约束名，列 = FK 列。
 * 这不是架构与库的语义差异，但**必须精确匹配**才允许抵消，否则会掩盖真实多余索引。
 */
function extractForeignKey(item: readonly Tok[]): ForeignKeyShape | null {
  const fkAt = item.findIndex((t) => t.k === 'id' && t.t === 'foreign' && t.q !== true);
  if (fkAt === -1) return null;
  const nameTok = item[1];
  if (nameTok === undefined || (item[0] as Tok).t !== 'constraint') return null;
  let i = fkAt + 1;
  if (item[i]?.t === 'key') i += 1;
  if (item[i]?.k !== 'p' || (item[i] as Tok).t !== '(') return null;
  const close = matchParen(item, i);
  const columns = item
    .slice(i + 1, close)
    .filter((t) => t.t !== ',')
    .map((t) => t.t);
  return { name: nameTok.t, columns };
}

/** 找到与 open 索引处左括号匹配的右括号索引。 */
function matchParen(toks: readonly Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i += 1) {
    const t = toks[i] as Tok;
    if (t.k !== 'p') continue;
    if (t.t === '(') depth += 1;
    else if (t.t === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('括号未闭合');
}

/** 表选项规范化：拆成 key=value，丢弃 AUTO_INCREMENT 计数器，按 key 排序。 */
function canonicalOptions(toks: readonly Tok[]): string {
  const map = new Map<string, string>();
  let i = 0;
  while (i < toks.length) {
    let key = (toks[i] as Tok).t;
    i += 1;
    if (key === 'default') {
      key = (toks[i] as Tok).t;
      i += 1;
    }
    if (key === 'character') {
      // CHARACTER SET = x
      if (toks[i]?.t === 'set') i += 1;
      key = 'charset';
    }
    if (key === 'auto_increment') {
      if (toks[i]?.t === '=') i += 1;
      i += 1; // 计数器值：空表与有数据的表天然不同，不是 schema 差异
      continue;
    }
    if (toks[i]?.t === '=') i += 1;
    const val = toks[i];
    if (val === undefined) throw new Error(`表选项 ${key} 缺少值`);
    i += 1;
    map.set(key, val.t);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/** 索引/约束体规范化。 */
function canonicalKeyOrConstraint(toks: readonly Tok[]): string {
  const head: string[] = [];
  let i = 0;
  // 前导关键字 + 可选索引名
  while (i < toks.length) {
    const t = (toks[i] as Tok).t;
    if (t === '(' || t === 'check' || t === 'foreign') break;
    head.push(t);
    i += 1;
  }
  if (i < toks.length && (toks[i] as Tok).t === 'check') {
    head.push('check');
    i += 1;
    const open = i;
    const close = matchParen(toks, open);
    const expr = canonicalExpr(toks.slice(open + 1, close));
    return `${head.join(' ')} (${expr})`;
  }
  if (i < toks.length && (toks[i] as Tok).t === 'foreign') {
    head.push('foreign');
    i += 1;
    if (toks[i]?.t === 'key') {
      head.push('key');
      i += 1;
    }
    // FOREIGN KEY (cols) REFERENCES tbl (cols) [ON DELETE ...] [ON UPDATE ...]
    const parts: string[] = [head.join(' ')];
    const open = i;
    const close = matchParen(toks, open);
    parts.push(`(${toks.slice(open + 1, close).map((t) => t.t).join(',')})`);
    i = close + 1;
    const tail: string[] = [];
    while (i < toks.length) {
      tail.push((toks[i] as Tok).t);
      i += 1;
    }
    // references 之后的表名/列名保持原样，动作关键字小写
    parts.push(tail.join(' ').replace(/\s+\(/g, '(').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'));
    return parts.join(' ');
  }

  // 普通索引：KEY name (col [ASC|DESC], (expr), ...) [USING BTREE] [WITH PARSER ngram]
  const parts: string[] = [head.join(' ')];
  if (toks[i]?.k === 'p' && (toks[i] as Tok).t === '(') {
    const open = i;
    const close = matchParen(toks, open);
    const inner = toks.slice(open + 1, close);
    // 按顶层逗号拆分索引部件
    const items: string[] = [];
    let depth = 0;
    let cur: Tok[] = [];
    for (const t of inner) {
      if (t.k === 'p' && t.t === '(') depth += 1;
      if (t.k === 'p' && t.t === ')') depth -= 1;
      if (t.k === 'p' && t.t === ',' && depth === 0) {
        items.push(renderIndexPart(cur));
        cur = [];
        continue;
      }
      cur.push(t);
    }
    if (cur.length > 0) items.push(renderIndexPart(cur));
    parts.push(`(${items.join(',')})`);
    i = close + 1;
  }
  const tail: string[] = [];
  while (i < toks.length) {
    tail.push((toks[i] as Tok).t);
    i += 1;
  }
  if (tail.length > 0) parts.push(tail.join(' '));
  return parts.join(' ').replace(/\s+,/g, ',');
}

function renderIndexPart(toks: readonly Tok[]): string {
  if (toks.length === 0) return '';
  // 表达式部件：整体被括号包住
  if ((toks[0] as Tok).t === '(' && matchParen(toks, 0) === toks.length - 1) {
    return `(${canonicalExpr(toks.slice(1, -1))})`;
  }
  // 列名 [长度] [ASC|DESC]
  return toks.map((t) => t.t).join(' ').replace(/\s+\(/g, '(').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+,/g, ',');
}

/** 列定义规范化。tableCharset/tableCollation 用于消解「等于表默认则省略」。 */
function canonicalColumn(toks: readonly Tok[], tableCharset: string, tableCollation: string): ColumnShape {
  const name = (toks[0] as Tok).t;
  const type = canonicalType(toks, 1);
  let i = type.next;
  const pieces: string[] = [name, type.text];

  let nullable = true;
  let hasDefault = false;
  let charset: string | null = null;
  let collation: string | null = null;
  const tail: string[] = [];

  while (i < toks.length) {
    const t = (toks[i] as Tok).t;
    if (t === 'character') {
      // CHARACTER SET x
      i += 1;
      if (toks[i]?.t === 'set') i += 1;
      charset = (toks[i] as Tok).t;
      i += 1;
      continue;
    }
    if (t === 'charset') {
      i += 1;
      if (toks[i]?.t === '=') i += 1;
      charset = (toks[i] as Tok).t;
      i += 1;
      continue;
    }
    if (t === 'collate') {
      i += 1;
      collation = (toks[i] as Tok).t;
      i += 1;
      continue;
    }
    if (t === 'not') {
      i += 1;
      if (toks[i]?.t !== 'null') throw new Error(`列 ${name} 的 NOT 后不是 NULL`);
      i += 1;
      nullable = false;
      pieces.push('not null');
      continue;
    }
    if (t === 'null') {
      i += 1;
      nullable = true;
      continue;
    }
    if (t === 'default') {
      i += 1;
      hasDefault = true;
      // 表达式默认值带括号；标量不带
      if (toks[i]?.k === 'p' && (toks[i] as Tok).t === '(') {
        const close = matchParen(toks, i);
        pieces.push(`default (${canonicalExpr(toks.slice(i + 1, close))})`);
        i = close + 1;
      } else {
        const start = i;
        // 标量默认值可能是函数调用 current_timestamp(3)
        if (toks[i + 1]?.k === 'p' && (toks[i + 1] as Tok).t === '(') {
          const close = matchParen(toks, i + 1);
          pieces.push(`default ${canonicalExpr(toks.slice(start, close + 1))}`);
          i = close + 1;
        } else {
          let end = start + 1;
          const head = toks[start] as Tok;
          // 字符集引导符 + 字符串是两个 token（_utf8mb4'x'），必须一起消费，
          // 否则引导符会被单独当成默认值、字符串落进 tail。
          if (head.k === 'id' && /^_[a-z0-9]+$/.test(head.t) && toks[start + 1]?.k === 'str') {
            end = start + 2;
          } else if (head.k === 'p' && (head.t === '-' || head.t === '+') && toks[start + 1]?.k === 'num') {
            end = start + 2;
          }
          pieces.push(`default ${canonicalExpr(toks.slice(start, end))}`);
          i = end;
        }
      }
      continue;
    }
    if (t === 'generated') {
      // GENERATED ALWAYS AS (expr) STORED|VIRTUAL
      i += 1;
      if (toks[i]?.t === 'always') i += 1;
      if (toks[i]?.t !== 'as') throw new Error(`列 ${name} 生成列缺少 AS`);
      i += 1;
      const open = i;
      const close = matchParen(toks, open);
      const expr = canonicalExpr(toks.slice(open + 1, close));
      i = close + 1;
      const kind = toks[i]?.t === 'virtual' ? 'virtual' : 'stored';
      if (toks[i]?.t === 'stored' || toks[i]?.t === 'virtual') i += 1;
      pieces.push(`generated always as (${expr}) ${kind}`);
      continue;
    }
    if (t === 'as') {
      // 简写生成列：AS (expr) [STORED|VIRTUAL]
      i += 1;
      const open = i;
      const close = matchParen(toks, open);
      const expr = canonicalExpr(toks.slice(open + 1, close));
      i = close + 1;
      const kind = toks[i]?.t === 'virtual' ? 'virtual' : 'stored';
      if (toks[i]?.t === 'stored' || toks[i]?.t === 'virtual') i += 1;
      pieces.push(`generated always as (${expr}) ${kind}`);
      continue;
    }
    if (t === 'on') {
      // ON UPDATE CURRENT_TIMESTAMP(3)
      const start = i;
      i += 1;
      if (toks[i]?.t !== 'update') throw new Error(`列 ${name} 的 ON 后不是 UPDATE`);
      i += 1;
      const vstart = i;
      if (toks[i + 1]?.k === 'p' && (toks[i + 1] as Tok).t === '(') {
        const close = matchParen(toks, i + 1);
        i = close + 1;
      } else {
        i += 1;
      }
      pieces.push(`on update ${canonicalExpr(toks.slice(vstart, i))}`);
      void start;
      continue;
    }
    if (t === 'comment') {
      i += 1;
      pieces.push(`comment ${(toks[i] as Tok).t}`);
      i += 1;
      continue;
    }
    tail.push(t);
    i += 1;
  }

  // 只写 COLLATE 时 MySQL 会补出对应 CHARACTER SET（ascii_bin → ascii）：
  // collation 已唯一确定 charset，故这是渲染变换而非语义差异，两侧统一补全后再比。
  if (charset === null && collation !== null) {
    charset = collation.split('_')[0] ?? null;
  }

  // charset/collate：等于表默认则省略（MySQL 就是这么渲染的）
  const explicitCharset = charset !== null && charset !== tableCharset ? charset : null;
  const explicitCollation = collation !== null && collation !== tableCollation ? collation : null;
  if (explicitCharset !== null || explicitCollation !== null) {
    const insertAt = 2;
    if (explicitCharset !== null) pieces.splice(insertAt, 0, `character set ${explicitCharset}`);
    if (explicitCollation !== null) pieces.splice(explicitCharset !== null ? insertAt + 1 : insertAt, 0, `collate ${explicitCollation}`);
  }
  // 可空且无显式默认 → MySQL 补 DEFAULT NULL
  if (nullable && !hasDefault && !pieces.some((p) => p.startsWith('generated always'))) {
    pieces.push('default null');
  }
  if (tail.length > 0) pieces.push(tail.join(' '));
  return { name, canonical: pieces.join(' ') };
}

/** 解析一条 CREATE TABLE 为规范结构。 */
export function parseCreateTable(ddl: string): TableShape {
  const toks = lex(ddl);
  // 定位 CREATE TABLE [IF NOT EXISTS] name
  let i = 0;
  if (toks[i]?.t !== 'create') throw new Error('不是 CREATE TABLE 语句');
  i += 1;
  if (toks[i]?.t === 'temporary') i += 1;
  if (toks[i]?.t !== 'table') throw new Error('不是 CREATE TABLE 语句');
  i += 1;
  if (toks[i]?.t === 'if') {
    i += 1;
    if (toks[i]?.t !== 'not') throw new Error('IF 后不是 NOT');
    i += 1;
    if (toks[i]?.t !== 'exists') throw new Error('IF NOT 后不是 EXISTS');
    i += 1;
  }
  const name = (toks[i] as Tok).t;
  i += 1;
  if (toks[i]?.k !== 'p' || (toks[i] as Tok).t !== '(') throw new Error(`表 ${name} 缺少列定义括号`);
  const bodyOpen = i;
  const bodyClose = matchParen(toks, bodyOpen);
  const body = toks.slice(bodyOpen + 1, bodyClose);
  const optionToks = toks.slice(bodyClose + 1);

  // 先求表默认 charset/collation，供列级消解
  const optText = canonicalOptions(optionToks);
  const optMap = new Map(optText.split(' ').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    return [kv.slice(0, eq), kv.slice(eq + 1)] as const;
  }));
  const tableCharset = optMap.get('charset') ?? 'utf8mb4';
  const tableCollation = optMap.get('collate') ?? 'utf8mb4_0900_ai_ci';

  // 按顶层逗号拆分表体
  const items: Tok[][] = [];
  let depth = 0;
  let cur: Tok[] = [];
  for (const t of body) {
    if (t.k === 'p' && t.t === '(') depth += 1;
    if (t.k === 'p' && t.t === ')') depth -= 1;
    if (t.k === 'p' && t.t === ',' && depth === 0) {
      items.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length > 0) items.push(cur);

  const columns: ColumnShape[] = [];
  const keys: string[] = [];
  const constraints: string[] = [];
  const foreignKeys: ForeignKeyShape[] = [];
  for (const item of items) {
    if (item.length === 0) continue;
    const head = item[0] as Tok;
    // 反引号包裹的一定是列名（例如保留字列 `key`），不能当成索引声明关键字。
    if (head.q !== true && KEY_STARTERS.includes(head.t)) {
      const canonical = canonicalKeyOrConstraint(item);
      if (head.t === 'constraint' || head.t === 'foreign') {
        constraints.push(canonical);
        const fk = extractForeignKey(item);
        if (fk !== null) foreignKeys.push(fk);
      } else keys.push(canonical);
      continue;
    }
    columns.push(canonicalColumn(item, tableCharset, tableCollation));
  }

  return {
    name,
    columns,
    keys: [...keys].sort(),
    constraints: [...constraints].sort(),
    foreignKeys,
    options: optText,
  };
}

// ── 比对 ─────────────────────────────────────────────────────────────────────

export interface TableDiff {
  readonly table: string;
  readonly equal: boolean;
  readonly problems: readonly string[];
}

function diffLists(label: string, expected: readonly string[], actual: readonly string[]): string[] {
  const problems: string[] = [];
  const e = new Set(expected);
  const a = new Set(actual);
  for (const x of expected) if (!a.has(x)) problems.push(`${label} 仅在架构侧：${x}`);
  for (const x of actual) if (!e.has(x)) problems.push(`${label} 仅在数据库侧：${x}`);
  return problems;
}

/** 比对同一张表的架构 DDL 与真实 SHOW CREATE TABLE。列按序比，键/约束按集合比。 */
export function compareTable(expectedDdl: string, actualDdl: string): TableDiff {
  const expected = parseCreateTable(expectedDdl);
  const actual = parseCreateTable(actualDdl);
  const problems: string[] = [];

  if (expected.name !== actual.name) problems.push(`表名不同：架构 ${expected.name} / 库 ${actual.name}`);
  if (expected.columns.length !== actual.columns.length) {
    problems.push(`列数不同：架构 ${String(expected.columns.length)} / 库 ${String(actual.columns.length)}`);
  }
  const len = Math.max(expected.columns.length, actual.columns.length);
  for (let i = 0; i < len; i += 1) {
    const e = expected.columns[i];
    const a = actual.columns[i];
    if (e === undefined) {
      problems.push(`第 ${String(i + 1)} 列仅数据库有：${a?.canonical ?? ''}`);
      continue;
    }
    if (a === undefined) {
      problems.push(`第 ${String(i + 1)} 列仅架构有：${e.canonical}`);
      continue;
    }
    if (e.name !== a.name) problems.push(`第 ${String(i + 1)} 列名不同：架构 ${e.name} / 库 ${a.name}`);
    if (e.canonical !== a.canonical) {
      problems.push(`列 ${e.name} 定义不同：\n      架构: ${e.canonical}\n      数据库: ${a.canonical}`);
    }
  }
  // MySQL 对未显式建索引的 FK 列自动补建索引（名=约束名，列=FK 列）。
  // 只抵消「精确匹配所声明 FK」且架构侧未显式声明的那些；其余多余索引仍报差异。
  const fkAutoKeys = new Set(
    expected.foreignKeys.map((fk) => `key ${fk.name} (${fk.columns.join(',')})`),
  );
  const expectedKeys = new Set(expected.keys);
  const actualKeys = actual.keys.filter((k) => !fkAutoKeys.has(k) || expectedKeys.has(k));
  problems.push(...diffLists('索引', expected.keys, actualKeys));
  problems.push(...diffLists('约束', expected.constraints, actual.constraints));
  if (expected.options !== actual.options) {
    problems.push(`表选项不同：架构 [${expected.options}] / 库 [${actual.options}]`);
  }
  return { table: expected.name, equal: problems.length === 0, problems };
}

export interface CompareReport {
  readonly total: number;
  readonly identical: number;
  readonly diffs: readonly TableDiff[];
}

/**
 * 解析 `cli.ts show-create` 产出的取证文件。
 * 格式：`-- ===== 表名 =====` 后跟一条以分号结尾的 SHOW CREATE TABLE 原文。
 */
export function parseShowCreateDump(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^-- ===== ([A-Za-z0-9_]+) =====\r?\n([\s\S]*?);\s*$/gm;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    const ddl = m[2];
    if (name === undefined || ddl === undefined) continue;
    out.set(name, ddl.trim());
  }
  return out;
}

/**
 * 只抹掉表选项里的 `AUTO_INCREMENT=N` 计数器，其余一律逐字保留。
 *
 * 为什么需要它：取证文件是**播种前**抓的纯 schema 快照，而计数器是**数据状态**——
 * 只要往自增表插过一行（种子 12 条 quota_ledger、并发探针插的 render_job），
 * 活库 SHOW CREATE TABLE 就会多出 `AUTO_INCREMENT=N`，且 N 随执行次数单调增长。
 * 故「取证文件逐字新鲜度」校验必须先抹掉这一个计数器，否则每跑一次测试就假红一次。
 * 除计数器外**不做任何规范化**：列/类型/默认/索引/约束的任何差异仍逐字暴露。
 *
 * 边界：只处理收尾 `)` 之后的表选项区，列上的 AUTO_INCREMENT 属性不动；
 * 引号内（如 COMMENT='AUTO_INCREMENT=5'）的同名文本不动。
 */
export function stripAutoIncrementCounter(ddl: string): string {
  const cut = ddl.lastIndexOf('\n)');
  if (cut < 0) return ddl; // 不是 SHOW CREATE TABLE 的多行形态：原样返回，不猜
  const head = ddl.slice(0, cut + 2); // 含收尾的 ')'
  const tail = ddl.slice(cut + 2);
  let out = '';
  let i = 0;
  while (i < tail.length) {
    const ch = tail[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < tail.length) {
        const cur = tail[j] as string;
        if (cur === '\\' && quote !== '`') {
          j += 2;
          continue;
        }
        if (cur === quote) {
          if (tail[j + 1] === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += tail.slice(i, j);
      i = j;
      continue;
    }
    const prev = i > 0 ? (tail[i - 1] as string) : ' ';
    if (/\s/.test(prev)) {
      const m = /^AUTO_INCREMENT\s*=\s*\d+[ \t]*/i.exec(tail.slice(i));
      if (m !== null) {
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  // 只有真的删过计数器才收尾随空白，保证「无计数器时是恒等变换」
  return head + (out === tail ? tail : out.replace(/[ \t]+$/, ''));
}

/** 批量比对。expectedDdls 来自架构基线迁移，actualDdls 来自真实 SHOW CREATE TABLE。 */
export function compareAll(
  expectedDdls: ReadonlyMap<string, string>,
  actualDdls: ReadonlyMap<string, string>,
): CompareReport {
  const diffs: TableDiff[] = [];
  let identical = 0;
  for (const [table, expected] of expectedDdls) {
    const actual = actualDdls.get(table);
    if (actual === undefined) {
      diffs.push({ table, equal: false, problems: ['数据库中不存在该表'] });
      continue;
    }
    const d = compareTable(expected, actual);
    if (d.equal) identical += 1;
    else diffs.push(d);
  }
  for (const table of actualDdls.keys()) {
    if (!expectedDdls.has(table)) diffs.push({ table, equal: false, problems: ['架构基线中不存在该表（多余表）'] });
  }
  return { total: expectedDdls.size, identical, diffs };
}