/**
 * The adapter language's syntax tree. Each node carries the line and column it started at, so a
 * runtime error can name the place it happened in the adapter's own code.
 */

/** A place in the source: one-based line, one-based column. */
export interface Pos {
  line: number;
  column: number;
}

/** The binary operators the language has, grouped by precedence in `parse.ts`. */
export type BinOp = "*" | "/" | "%" | "+" | "-" | "<" | "<=" | ">" | ">=" | "===" | "!==" | "&&" | "||" | "??";

/** The prefix operators the language has. */
export type UnOp = "!" | "-" | "+" | "typeof";

/** A spread element inside an array literal: `...a`. */
export type Spread = { t: "spread"; arg: Expr } & Pos;

/** A property inside an object literal, either `key: value` or `...value`. */
export type Prop = ({ t: "prop"; key: string; value: Expr } & Pos) | ({ t: "pSpread"; arg: Expr } & Pos);

export type Expr =
  | ({ t: "num"; value: number } & Pos)
  | ({ t: "str"; value: string } & Pos)
  | ({ t: "tmpl"; quasis: string[]; parts: Expr[] } & Pos)
  | ({ t: "bool"; value: boolean } & Pos)
  | ({ t: "null" } & Pos)
  | ({ t: "undef" } & Pos)
  | ({ t: "ident"; name: string } & Pos)
  | ({ t: "array"; items: (Expr | Spread)[] } & Pos)
  | ({ t: "object"; props: Prop[] } & Pos)
  /** `obj.name` when `computed` is false, `obj[key]` when it is true. */
  | ({ t: "member"; obj: Expr; key: Expr; computed: boolean; optional: boolean } & Pos)
  | ({ t: "call"; callee: Expr; args: Expr[]; optional: boolean } & Pos)
  | ({ t: "unary"; op: UnOp; arg: Expr } & Pos)
  | ({ t: "binary"; op: BinOp; left: Expr; right: Expr } & Pos)
  | ({ t: "ternary"; test: Expr; then: Expr; alt: Expr } & Pos)
  | ({ t: "arrow"; params: string[]; body: Expr | Stmt; exprBody: boolean } & Pos)
  /** `new Error(msg)`; the only `new` the language has. */
  | ({ t: "error"; arg: Expr } & Pos)
  | ({ t: "assign"; op: "=" | "+=" | "-="; target: Expr; value: Expr } & Pos);

/** A statement: one of the two flow controls returns a signal instead of a value. */
export type Stmt =
  | ({ t: "block"; body: Stmt[] } & Pos)
  | ({ t: "let"; mutable: boolean; name: string; init: Expr } & Pos)
  | ({ t: "if"; test: Expr; then: Stmt; alt: Stmt | null } & Pos)
  | ({ t: "while"; test: Expr; body: Stmt } & Pos)
  | ({ t: "forOf"; mutable: boolean; name: string; iter: Expr; body: Stmt } & Pos)
  | ({ t: "break" } & Pos)
  | ({ t: "continue" } & Pos)
  | ({ t: "return"; arg: Expr | null } & Pos)
  | ({ t: "try"; block: Stmt; param: string | null; handler: Stmt | null; finalizer: Stmt | null } & Pos)
  | ({ t: "throw"; arg: Expr } & Pos)
  | ({ t: "expr"; e: Expr } & Pos)
  | ({ t: "func"; name: string; params: string[]; body: Stmt } & Pos)
  | ({ t: "empty" } & Pos);

/** A top-level declaration: a function (hoisted) or a `const`. */
export type TopDecl = ({ t: "func"; name: string; params: string[]; body: Stmt } & Pos) | ({ t: "const"; name: string; init: Expr } & Pos);

/** A parsed adapter module. */
export interface Program {
  body: TopDecl[];
}
