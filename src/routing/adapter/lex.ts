/**
 * The lexer: adapter source text in, tokens out.
 *
 * A template string carries whole expressions inside it, so those are lexed here as their own token
 * lists; the parser then only ever sees a sequence of tokens.
 */

import { ParseFail } from "./errors.js";

export type TokenKind = "num" | "str" | "template" | "ident" | "punct" | "eof";

/** A template string's pieces: the literal runs, and the token list for each `${}` expression. */
export interface TemplateParts {
  quasis: string[];
  exprs: Token[][];
}

export interface Token {
  kind: TokenKind;
  /** The text of the token, or the value of a string. */
  value: string;
  /** The value of a number token. */
  num?: number;
  /** The pieces of a template token. */
  tpl?: TemplateParts;
  line: number;
  column: number;
}

/** The punctuators, longest first, so `===` wins over `==` and `=`. */
const PUNCT = [
  "...",
  "?.",
  "===",
  "!==",
  "=>",
  ">=",
  "<=",
  "&&",
  "||",
  "??",
  "+=",
  "-=",
  "==",
  "!=",
  "++",
  "--",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  ".",
  ":",
  "?",
  "=",
  "!",
  ">",
  "<",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
];

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;

/** Lex `code` into tokens, ending with an `eof` token. */
export function lex(code: string): Token[] {
  return new Lexer(code).all();
}

class Lexer {
  private index = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly code: string) {}

  all(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const token = this.token();
      out.push(token);
      if (token.kind === "eof") return out;
    }
  }

  private fail(reason: string, line = this.line, column = this.column): never {
    throw new ParseFail(reason, line, column);
  }

  private peek(off = 0): string | undefined {
    return this.code[this.index + off];
  }

  private take(): string {
    const ch = this.code[this.index]!;
    this.index += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  /** One token, skipping whitespace and comments first. */
  token(): Token {
    this.skip();
    const line = this.line;
    const column = this.column;
    const ch = this.peek();
    if (ch === undefined) return { kind: "eof", value: "", line, column };
    if (DIGIT.test(ch)) return this.number();
    if (ch === '"' || ch === "'") return this.string(ch);
    if (ch === "`") return this.template();
    if (IDENT_START.test(ch)) {
      let name = "";
      while (this.peek() !== undefined && IDENT_PART.test(this.peek()!)) name += this.take();
      return { kind: "ident", value: name, line, column };
    }
    for (const p of PUNCT) {
      if (this.code.startsWith(p, this.index)) {
        for (let i = 0; i < p.length; i += 1) this.take();
        return { kind: "punct", value: p, line, column };
      }
    }
    return this.fail(`unexpected character ${JSON.stringify(ch)}`);
  }

  private skip(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.take();
        continue;
      }
      if (ch === "/" && this.peek(1) === "/") {
        while (this.peek() !== undefined && this.peek() !== "\n") this.take();
        continue;
      }
      if (ch === "/" && this.peek(1) === "*") {
        const line = this.line;
        const column = this.column;
        this.take();
        this.take();
        for (;;) {
          if (this.peek() === undefined) this.fail("unterminated comment", line, column);
          if (this.peek() === "*" && this.peek(1) === "/") {
            this.take();
            this.take();
            break;
          }
          this.take();
        }
        continue;
      }
      return;
    }
  }

  private number(): Token {
    const line = this.line;
    const column = this.column;
    let text = "";
    while (this.peek() !== undefined && DIGIT.test(this.peek()!)) text += this.take();
    if (this.peek() === "." && this.peek(1) !== undefined && DIGIT.test(this.peek(1)!)) {
      text += this.take();
      while (this.peek() !== undefined && DIGIT.test(this.peek()!)) text += this.take();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      let ahead = 1;
      if (this.peek(ahead) === "+" || this.peek(ahead) === "-") ahead += 1;
      const digit = this.peek(ahead);
      if (digit !== undefined && DIGIT.test(digit)) {
        text += this.take();
        if (this.peek() === "+" || this.peek() === "-") text += this.take();
        while (this.peek() !== undefined && DIGIT.test(this.peek()!)) text += this.take();
      }
    }
    return { kind: "num", value: text, num: Number(text), line, column };
  }

  private string(quote: string): Token {
    const line = this.line;
    const column = this.column;
    this.take();
    let text = "";
    for (;;) {
      const ch = this.peek();
      if (ch === undefined || ch === "\n") this.fail("unterminated string", line, column);
      if (ch === quote) {
        this.take();
        return { kind: "str", value: text, line, column };
      }
      if (ch === "\\") {
        text += this.escape();
        continue;
      }
      text += this.take();
    }
  }

  private template(): Token {
    const line = this.line;
    const column = this.column;
    this.take();
    const quasis: string[] = [];
    const exprs: Token[][] = [];
    let chunk = "";
    for (;;) {
      const ch = this.peek();
      if (ch === undefined) this.fail("unterminated template string", line, column);
      if (ch === "`") {
        this.take();
        quasis.push(chunk);
        return { kind: "template", value: "", tpl: { quasis, exprs }, line, column };
      }
      if (ch === "\\") {
        chunk += this.escape();
        continue;
      }
      if (ch === "$" && this.peek(1) === "{") {
        this.take();
        this.take();
        quasis.push(chunk);
        chunk = "";
        exprs.push(this.templateExpr(line, column));
        continue;
      }
      chunk += this.take();
    }
  }

  /** The tokens of one `${ ... }` inside a template string, up to its closing brace. */
  private templateExpr(line: number, column: number): Token[] {
    const out: Token[] = [];
    let depth = 0;
    for (;;) {
      const token = this.token();
      if (token.kind === "eof") this.fail("unterminated template expression", line, column);
      if (token.kind === "punct" && token.value === "}") {
        if (depth === 0) return out;
        depth -= 1;
      }
      if (token.kind === "punct" && token.value === "{") depth += 1;
      out.push(token);
    }
  }

  /** The escape sequence after a backslash, as the character it stands for. */
  private escape(): string {
    this.take();
    const ch = this.peek();
    if (ch === undefined) this.fail("unterminated escape");
    this.take();
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "\\":
      case "'":
      case '"':
      case "`":
      case "$":
        return ch;
      case "\n":
        return "";
      case "u": {
        if (this.peek() === "{") {
          this.take();
          let hex = "";
          while (this.peek() !== undefined && this.peek() !== "}") hex += this.take();
          if (this.peek() !== "}") this.fail("unterminated unicode escape");
          this.take();
          return hex === "" ? this.fail("empty unicode escape") : String.fromCodePoint(Number.parseInt(hex, 16));
        }
        let hex = "";
        for (let i = 0; i < 4; i += 1) {
          const digit = this.peek();
          if (digit === undefined || !HEX.test(digit)) this.fail("bad unicode escape");
          hex += this.take();
        }
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case "x": {
        let hex = "";
        for (let i = 0; i < 2; i += 1) {
          const digit = this.peek();
          if (digit === undefined || !HEX.test(digit)) this.fail("bad hex escape");
          hex += this.take();
        }
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return ch;
    }
  }
}
