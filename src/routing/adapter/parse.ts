/**
 * The parser: tokens in, a module's syntax tree out.
 *
 * It is a hand-written recursive-descent parser for the subset of JavaScript the adapter language is,
 * and it refuses the rest of JavaScript on purpose, with a message that says which feature was used.
 * The top level may hold only `const` declarations and functions; everything a request does lives
 * inside one of those.
 */

import type { BinOp, Expr, Pos, Prop, Program, Spread, Stmt, TopDecl, UnOp } from "./ast.js";
import { ParseFail } from "./errors.js";
import { type Token, lex } from "./lex.js";
import { keyAllowed } from "./values.js";

/** How deeply expressions and statements may nest before the parser refuses the file. */
const NESTING = 256;

/** Names that cannot be declared, because the language or its future uses them. */
const RESERVED = new Set([
  "let",
  "const",
  "if",
  "else",
  "for",
  "of",
  "in",
  "while",
  "do",
  "break",
  "continue",
  "return",
  "function",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "true",
  "false",
  "null",
  "undefined",
  "new",
  "this",
  "class",
  "import",
  "export",
  "async",
  "await",
  "eval",
  "switch",
  "delete",
  "void",
  "instanceof",
  "var",
  "with",
  "debugger",
  "yield",
  "super",
  "extends",
]);

/** Parse adapter source into a module. Throws `ParseFail`, which `compile` turns into the reported error. */
export function parse(code: string): Program {
  return new Parser(lex(code)).program();
}

const at = (t: Token): Pos => ({ line: t.line, column: t.column });

/** How a token is named in a parse error. */
function shown(t: Token): string {
  if (t.kind === "eof") return "end of input";
  if (t.kind === "str") return `string ${JSON.stringify(t.value)}`;
  return t.value;
}

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private depth = 0,
  ) {}

  // --- reading tokens -------------------------------------------------------

  private peek(off = 0): Token {
    return this.tokens[this.i + off] ?? this.tokens[this.tokens.length - 1]!;
  }

  private eof(): boolean {
    return this.peek().kind === "eof";
  }

  private isPunct(value: string, off = 0): boolean {
    const t = this.peek(off);
    return t.kind === "punct" && t.value === value;
  }

  private isIdent(value: string, off = 0): boolean {
    const t = this.peek(off);
    return t.kind === "ident" && t.value === value;
  }

  private fail(reason: string, t: Token | Pos = this.peek()): never {
    throw new ParseFail(reason, t.line, t.column);
  }

  private expectPunct(value: string): Token {
    if (!this.isPunct(value)) this.fail(`expected ${value}, not ${shown(this.peek())}`);
    const t = this.peek();
    this.i += 1;
    return t;
  }

  private semicolon(): void {
    if (this.isPunct(";")) this.i += 1;
  }

  /** Take a name that may be declared; keywords and the guard's three names are refused. */
  private declaredName(): string {
    const t = this.peek();
    if (t.kind !== "ident") this.fail(`expected a name, not ${shown(t)}`);
    if (RESERVED.has(t.value)) this.fail(`${t.value} is a keyword and cannot be a name`);
    this.i += 1;
    return t.value;
  }

  // --- the module -----------------------------------------------------------

  program(): Program {
    const body: TopDecl[] = [];
    while (!this.eof()) {
      if (this.isIdent("export")) this.i += 1;
      const stmt = this.statement();
      if (stmt.t === "func") {
        body.push({ t: "func", name: stmt.name, params: stmt.params, body: stmt.body, line: stmt.line, column: stmt.column });
      } else if (stmt.t === "let" && !stmt.mutable) {
        body.push({ t: "const", name: stmt.name, init: stmt.init, line: stmt.line, column: stmt.column });
      } else {
        this.fail("the top level may hold only const declarations and functions", stmt);
      }
    }
    return { body };
  }

  // --- statements -----------------------------------------------------------

  private statement(): Stmt {
    this.depth += 1;
    if (this.depth > NESTING) this.fail("the code nests too deeply to read");
    try {
      return this.statementInner();
    } finally {
      this.depth -= 1;
    }
  }

  private statementInner(): Stmt {
    const t = this.peek();
    const here = at(t);
    if (t.kind === "punct" && t.value === "{") return this.block();
    if (t.kind === "punct" && t.value === ";") {
      this.i += 1;
      return { t: "empty", ...here };
    }
    if (t.kind === "ident") {
      switch (t.value) {
        case "let":
        case "const":
          return this.letConst();
        case "if":
          return this.ifStatement();
        case "while":
          return this.whileStatement();
        case "for":
          return this.forStatement();
        case "break":
        case "continue": {
          this.i += 1;
          this.noLabel();
          this.semicolon();
          return { t: t.value === "break" ? "break" : "continue", ...here };
        }
        case "return": {
          this.i += 1;
          const arg = this.isPunct(";") || this.isPunct("}") || this.eof() ? null : this.expression();
          this.semicolon();
          return { t: "return", arg, ...here };
        }
        case "try":
          return this.tryStatement();
        case "throw": {
          this.i += 1;
          const arg = this.expression();
          this.semicolon();
          return { t: "throw", arg, ...here };
        }
        case "function":
          return this.funcDeclaration();
        case "export":
          this.fail("export is only allowed at the top level");
        case "switch":
          this.fail("switch is not part of the adapter language");
        case "class":
          this.fail("classes are not part of the adapter language");
        case "import":
          this.fail("import is not part of the adapter language");
        case "do":
          this.fail("do...while is not part of the adapter language");
        default:
          // `name:` in statement position is a label, which the language does not have.
          if (this.isPunct(":", 1)) this.fail("labels are not part of the adapter language");
      }
    }
    const expr = this.expression();
    this.semicolon();
    return { t: "expr", e: expr, ...here };
  }

  /** `break foo` and `continue foo` are refused: there are no labels. */
  private noLabel(): void {
    if (this.peek().kind === "ident") this.fail("labels are not part of the adapter language");
  }

  private block(): Stmt {
    const open = this.expectPunct("{");
    const body: Stmt[] = [];
    while (!this.isPunct("}")) {
      if (this.eof()) this.fail("expected } to close the block", open);
      body.push(this.statement());
    }
    this.i += 1;
    return { t: "block", body, ...at(open) };
  }

  private letConst(): Stmt {
    const kw = this.peek();
    this.i += 1;
    const name = this.declaredName();
    const init = this.isPunct("=") ? (this.i++, this.expression()) : ({ t: "undef", ...at(kw) } as Expr);
    this.semicolon();
    return { t: "let", mutable: kw.value === "let", name, init, ...at(kw) };
  }

  private ifStatement(): Stmt {
    const kw = this.peek();
    this.i += 1;
    this.expectPunct("(");
    const test = this.expression();
    this.expectPunct(")");
    const then = this.statement();
    let alt: Stmt | null = null;
    if (this.isIdent("else")) {
      this.i += 1;
      alt = this.statement();
    }
    return { t: "if", test, then, alt, ...at(kw) };
  }

  private whileStatement(): Stmt {
    const kw = this.peek();
    this.i += 1;
    this.expectPunct("(");
    const test = this.expression();
    this.expectPunct(")");
    return { t: "while", test, body: this.statement(), ...at(kw) };
  }

  private forStatement(): Stmt {
    const kw = this.peek();
    this.i += 1;
    this.expectPunct("(");
    let mutable = false;
    if (this.isIdent("const") || this.isIdent("let")) {
      mutable = this.peek().value === "let";
      this.i += 1;
    } else if (this.peek().kind !== "ident") {
      this.fail("only for...of loops are part of the adapter language", kw);
    }
    const name = this.declaredName();
    if (!this.isIdent("of")) this.fail("only for...of loops are part of the adapter language", kw);
    this.i += 1;
    const iter = this.expression();
    this.expectPunct(")");
    return { t: "forOf", mutable, name, iter, body: this.statement(), ...at(kw) };
  }

  private tryStatement(): Stmt {
    const kw = this.peek();
    this.i += 1;
    const block = this.block();
    let param: string | null = null;
    let handler: Stmt | null = null;
    let finalizer: Stmt | null = null;
    if (this.isIdent("catch")) {
      this.i += 1;
      if (this.isPunct("(")) {
        this.i += 1;
        param = this.declaredName();
        this.expectPunct(")");
      }
      handler = this.block();
    }
    if (this.isIdent("finally")) {
      this.i += 1;
      finalizer = this.block();
    }
    if (handler === null && finalizer === null) this.fail("try needs a catch or a finally", kw);
    return { t: "try", block, param, handler, finalizer, ...at(kw) };
  }

  private funcDeclaration(): Stmt {
    const kw = this.peek();
    this.i += 1;
    const name = this.declaredName();
    const params = this.params();
    const body = this.block();
    return { t: "func", name, params, body, ...at(kw) };
  }

  private params(): string[] {
    this.expectPunct("(");
    const params: string[] = [];
    while (!this.isPunct(")")) {
      params.push(this.declaredName());
      if (this.isPunct(",")) this.i += 1;
      else break;
    }
    this.expectPunct(")");
    return params;
  }

  // --- expressions ----------------------------------------------------------

  expression(): Expr {
    this.depth += 1;
    if (this.depth > NESTING) this.fail("the code nests too deeply to read");
    try {
      return this.assignment();
    } finally {
      this.depth -= 1;
    }
  }

  private assignment(): Expr {
    const left = this.ternary();
    const t = this.peek();
    if (t.kind === "punct" && (t.value === "=" || t.value === "+=" || t.value === "-=")) {
      if (left.t !== "ident" && left.t !== "member") this.fail("only a variable or a property can be assigned to", left);
      this.i += 1;
      const value = this.assignment();
      return { t: "assign", op: t.value, target: left, value, line: left.line, column: left.column };
    }
    return left;
  }

  private ternary(): Expr {
    const test = this.nullish();
    if (!this.isPunct("?")) return test;
    this.i += 1;
    const then = this.assignment();
    this.expectPunct(":");
    const alt = this.assignment();
    return { t: "ternary", test, then, alt, line: test.line, column: test.column };
  }

  private nullish(): Expr {
    return this.chain(["??"], () => this.or());
  }

  private or(): Expr {
    return this.chain(["||"], () => this.and());
  }

  private and(): Expr {
    return this.chain(["&&"], () => this.equality());
  }

  private equality(): Expr {
    let left = this.relationalOnce();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "punct") return left;
      if (t.value === "==" || t.value === "!=") this.fail("loose equality is not part of the adapter language; write === or !==");
      if (t.value !== "===" && t.value !== "!==") return left;
      this.i += 1;
      const right = this.relationalOnce();
      left = { t: "binary", op: t.value as BinOp, left, right, line: left.line, column: left.column };
    }
  }

  private relationalOnce(): Expr {
    return this.chain(["<", "<=", ">", ">="], () => this.additive());
  }

  private additive(): Expr {
    return this.chain(["+", "-"], () => this.multiplicative());
  }

  private multiplicative(): Expr {
    return this.chain(["*", "/", "%"], () => this.unary());
  }

  /** A left-associative run of one precedence level. */
  private chain(ops: string[], next: () => Expr): Expr {
    let left = next();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "punct" || !ops.includes(t.value)) return left;
      this.i += 1;
      const right = next();
      left = { t: "binary", op: t.value as BinOp, left, right, line: left.line, column: left.column };
    }
  }

  private unary(): Expr {
    this.depth += 1;
    if (this.depth > NESTING) this.fail("the code nests too deeply to read");
    try {
      return this.unaryInner();
    } finally {
      this.depth -= 1;
    }
  }

  private unaryInner(): Expr {
    const t = this.peek();
    if (t.kind === "punct" && (t.value === "!" || t.value === "-" || t.value === "+")) {
      this.i += 1;
      return { t: "unary", op: t.value as UnOp, arg: this.unary(), ...at(t) };
    }
    if (t.kind === "ident" && t.value === "typeof") {
      this.i += 1;
      return { t: "unary", op: "typeof", arg: this.unary(), ...at(t) };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let node = this.primary();
    let chained = false;
    for (;;) {
      const t = this.peek();
      if (t.kind !== "punct") return node;
      if (t.value === ".") {
        this.i += 1;
        const name = this.propertyName();
        node = { t: "member", obj: node, key: { t: "str", value: name, ...at(t) }, computed: false, optional: chained, ...at(t) };
        continue;
      }
      if (t.value === "?.") {
        this.i += 1;
        chained = true;
        if (this.isPunct("(")) {
          node = { t: "call", callee: node, args: this.args(), optional: true, ...at(t) };
          continue;
        }
        if (this.isPunct("[")) {
          const key = this.computedKey();
          node = { t: "member", obj: node, key, computed: true, optional: true, ...at(t) };
          continue;
        }
        const name = this.propertyName();
        node = { t: "member", obj: node, key: { t: "str", value: name, ...at(t) }, computed: false, optional: true, ...at(t) };
        continue;
      }
      if (t.value === "[") {
        node = { t: "member", obj: node, key: this.computedKey(), computed: true, optional: chained, ...at(t) };
        continue;
      }
      if (t.value === "(") {
        node = { t: "call", callee: node, args: this.args(), optional: chained, ...at(t) };
        continue;
      }
      if (t.value === "++" || t.value === "--") {
        this.fail(`${t.value} is not part of the adapter language; write += 1 or -= 1 instead`);
      }
      return node;
    }
  }

  /** The name after a `.`, refused here when it is one the guard will not allow anywhere. */
  private propertyName(): string {
    const t = this.peek();
    if (t.kind !== "ident") this.fail(`expected a property name, not ${shown(t)}`);
    if (!keyAllowed(t.value)) this.fail(`"${t.value}" is not a property name the adapter language allows`);
    this.i += 1;
    return t.value;
  }

  private computedKey(): Expr {
    this.expectPunct("[");
    const key = this.expression();
    this.expectPunct("]");
    return key;
  }

  private args(): Expr[] {
    this.expectPunct("(");
    const out: Expr[] = [];
    while (!this.isPunct(")")) {
      out.push(this.assignment());
      if (this.isPunct(",")) this.i += 1;
      else break;
    }
    this.expectPunct(")");
    return out;
  }

  private primary(): Expr {
    this.depth += 1;
    if (this.depth > NESTING) this.fail("the code nests too deeply to read");
    try {
      return this.primaryInner();
    } finally {
      this.depth -= 1;
    }
  }

  private primaryInner(): Expr {
    const t = this.peek();
    if (t.kind === "num") {
      this.i += 1;
      return { t: "num", value: t.num ?? 0, ...at(t) };
    }
    if (t.kind === "str") {
      this.i += 1;
      return { t: "str", value: t.value, ...at(t) };
    }
    if (t.kind === "template") {
      this.i += 1;
      return this.templateNode(t);
    }
    if (t.kind === "ident") return this.identExpr(t);
    if (t.kind === "punct") {
      if (t.value === "(") return this.parenOrArrow();
      if (t.value === "{") return this.objectLiteral();
      if (t.value === "[") return this.arrayLiteral();
      if (t.value === "/") this.fail("regex literals are not part of the adapter language");
      if (t.value === "++" || t.value === "--") this.fail(`${t.value} is not part of the adapter language; write += 1 or -= 1 instead`);
      if (t.value === "==" || t.value === "!=") this.fail("loose equality is not part of the adapter language; write === or !==");
      if (t.value === "...") this.fail("a spread is only allowed inside an array or object literal");
    }
    return this.fail(`unexpected token ${shown(t)}`);
  }

  private identExpr(t: Token): Expr {
    switch (t.value) {
      case "true":
      case "false":
        this.i += 1;
        return { t: "bool", value: t.value === "true", ...at(t) };
      case "null":
        this.i += 1;
        return { t: "null", ...at(t) };
      case "undefined":
        this.i += 1;
        return { t: "undef", ...at(t) };
      case "this":
        this.fail("this is not part of the adapter language");
      case "class":
        this.fail("classes are not part of the adapter language");
      case "import":
        this.fail("import is not part of the adapter language");
      case "async":
      case "await":
        this.fail("async and await are not part of the adapter language");
      case "eval":
        this.fail("eval is not part of the adapter language");
      case "new":
        return this.newError();
      case "function":
        this.fail("a function must be a declaration or an arrow function");
      default:
        break;
    }
    if (RESERVED.has(t.value)) this.fail(`${t.value} is not part of the adapter language`);
    this.i += 1;
    if (this.isPunct("=>")) {
      this.i += 1;
      return this.arrowBody([t.value], at(t));
    }
    return { t: "ident", name: t.value, ...at(t) };
  }

  private newError(): Expr {
    const kw = this.peek();
    this.i += 1;
    if (!this.isIdent("Error")) this.fail("new is only allowed for Error", kw);
    this.i += 1;
    this.expectPunct("(");
    const arg = this.expression();
    this.expectPunct(")");
    return { t: "error", arg, ...at(kw) };
  }

  private parenOrArrow(): Expr {
    const here = at(this.peek());
    const save = this.i;
    const arrow = this.tryArrow(here);
    if (arrow !== null) return arrow;
    this.i = save;
    this.expectPunct("(");
    const inner = this.expression();
    this.expectPunct(")");
    return inner;
  }

  private tryArrow(here: Pos): Expr | null {
    this.i += 1;
    const params: string[] = [];
    if (!this.isPunct(")")) {
      for (;;) {
        const t = this.peek();
        if (t.kind !== "ident" || RESERVED.has(t.value)) return null;
        params.push(t.value);
        this.i += 1;
        if (this.isPunct(",")) {
          this.i += 1;
          continue;
        }
        break;
      }
    }
    if (!this.isPunct(")")) return null;
    this.i += 1;
    if (!this.isPunct("=>")) return null;
    this.i += 1;
    return this.arrowBody(params, here);
  }

  private arrowBody(params: string[], here: Pos): Expr {
    if (this.isPunct("{")) return { t: "arrow", params, body: this.block(), exprBody: false, ...here };
    return { t: "arrow", params, body: this.assignment(), exprBody: true, ...here };
  }

  private templateNode(t: Token): Expr {
    const tpl = t.tpl!;
    const parts = tpl.exprs.map((tokens) => {
      const last = tokens[tokens.length - 1] ?? t;
      const sub = new Parser([...tokens, { kind: "eof", value: "", line: last.line, column: last.column + 1 }], this.depth);
      const e = sub.expression();
      if (!sub.eof()) sub.fail(`unexpected token ${shown(sub.peek())}`);
      return e;
    });
    return { t: "tmpl", quasis: tpl.quasis, parts, ...at(t) };
  }

  private arrayLiteral(): Expr {
    const open = this.expectPunct("[");
    const items: (Expr | Spread)[] = [];
    while (!this.isPunct("]")) {
      if (this.eof()) this.fail("expected ] to close the array", open);
      if (this.isPunct("...")) {
        const sp = this.peek();
        this.i += 1;
        items.push({ t: "spread", arg: this.assignment(), ...at(sp) });
      } else {
        items.push(this.assignment());
      }
      if (this.isPunct(",")) this.i += 1;
      else break;
    }
    this.expectPunct("]");
    return { t: "array", items, ...at(open) };
  }

  private objectLiteral(): Expr {
    const open = this.expectPunct("{");
    const props: Prop[] = [];
    while (!this.isPunct("}")) {
      if (this.eof()) this.fail("expected } to close the object", open);
      if (this.isPunct("...")) {
        const sp = this.peek();
        this.i += 1;
        props.push({ t: "pSpread", arg: this.assignment(), ...at(sp) });
      } else {
        const key = this.peek();
        let name: string;
        if (key.kind === "str") name = key.value;
        else if (key.kind === "num") name = String(key.num ?? 0);
        else if (key.kind === "ident") name = key.value;
        else return this.fail(`expected a property name, not ${shown(key)}`);
        if (!keyAllowed(name)) this.fail(`"${name}" is not a property name the adapter language allows`);
        this.i += 1;
        if (this.isPunct(":")) {
          this.i += 1;
          props.push({ t: "prop", key: name, value: this.assignment(), ...at(key) });
        } else {
          // `{ q }` is `{ q: q }`.
          if (key.kind !== "ident") this.fail(`expected : after the property name ${name}`);
          props.push({ t: "prop", key: name, value: { t: "ident", name, ...at(key) }, ...at(key) });
        }
      }
      if (this.isPunct(",")) this.i += 1;
      else break;
    }
    this.expectPunct("}");
    return { t: "object", props, ...at(open) };
  }
}
