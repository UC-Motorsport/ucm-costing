import Decimal from "decimal.js";

export const catalogFormulaVariables = [
  "size1",
  "size2",
  "size3",
  "size4",
  "c1",
  "c2",
  "c3",
  "c4",
  "area",
  "length",
  "density",
] as const;

export type CatalogFormulaVariable = (typeof catalogFormulaVariables)[number];
export type CatalogFormulaInputs = Partial<
  Record<CatalogFormulaVariable, Decimal.Value>
>;

type Token =
  | { kind: "number"; value: string }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "leftParen" }
  | { kind: "rightParen" };

type Expression =
  | { kind: "number"; value: string }
  | { kind: "variable"; name: CatalogFormulaVariable }
  | { kind: "unary"; operator: "+" | "-"; operand: Expression }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "^";
      left: Expression;
      right: Expression;
    }
  | { kind: "function"; name: "exp" | "sqrt"; argument: Expression };

export interface FormulaEvaluationSuccess {
  ok: true;
  raw: string;
  normalized: string;
  value: string;
}

export interface FormulaEvaluationFailure {
  ok: false;
  raw: string;
  normalized: string;
  error: string;
}

export type FormulaEvaluation =
  | FormulaEvaluationSuccess
  | FormulaEvaluationFailure;

/**
 * Converts only syntax observed in the Formula SAE-A catalogue into the small
 * grammar parsed below. This is intentionally not a spreadsheet formula
 * engine. Unknown syntax must stay visible as an import issue.
 */
export function normalizeCatalogFormula(raw: string): string {
  let normalized = raw.trim();
  if (normalized.startsWith("=")) {
    normalized = normalized.slice(1).trim();
  }

  normalized = normalized
    .replace(/\]\s*\[/g, "]*[")
    .replace(/\[\s*(size|c)\s*(\d)\s*\]/gi, (_, name: string, index: string) => {
      return `${name.toLowerCase()}${index}`;
    })
    .replace(/\[\s*(area|length|density)\s*\]/gi, (_, name: string) => {
      return name.toLowerCase();
    })
    .replace(/\bEXP\s*\(/gi, "exp(")
    .replace(/\be\s*\^\s*\(/gi, "exp(")
    .replace(/\*\*/g, "^")
    .replace(/\s+/g, " ");

  return normalized;
}

export function evaluateCatalogFormula(
  raw: string,
  inputs: CatalogFormulaInputs,
): FormulaEvaluation {
  const normalized = normalizeCatalogFormula(raw);

  try {
    if (!normalized) {
      throw new Error("Formula is empty");
    }

    const parser = new FormulaParser(tokenize(normalized));
    const expression = parser.parse();
    const value = evaluate(expression, inputs);

    if (!value.isFinite()) {
      throw new Error("Formula result is not finite");
    }

    return {
      ok: true,
      raw,
      normalized,
      value: value.toSignificantDigits(20).toString(),
    };
  } catch (error) {
    return {
      ok: false,
      raw,
      normalized,
      error: error instanceof Error ? error.message : "Unknown formula error",
    };
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const current = source[index];
    if (current === undefined) {
      break;
    }

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(current)) {
      const match = source
        .slice(index)
        .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) {
        throw new Error(`Invalid number at character ${index + 1}`);
      }
      tokens.push({ kind: "number", value: match[0] });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(current)) {
      const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) {
        throw new Error(`Invalid name at character ${index + 1}`);
      }
      tokens.push({ kind: "identifier", value: match[0].toLowerCase() });
      index += match[0].length;
      continue;
    }

    if (
      current === "+" ||
      current === "-" ||
      current === "*" ||
      current === "/" ||
      current === "^"
    ) {
      tokens.push({ kind: "operator", value: current });
      index += 1;
      continue;
    }

    if (current === "(") {
      tokens.push({ kind: "leftParen" });
      index += 1;
      continue;
    }

    if (current === ")") {
      tokens.push({ kind: "rightParen" });
      index += 1;
      continue;
    }

    throw new Error(
      `Unsupported character ${JSON.stringify(current)} at character ${index + 1}`,
    );
  }

  return tokens;
}

class FormulaParser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Expression {
    const expression = this.parseAdditive();
    if (this.peek()) {
      throw new Error(`Unexpected token ${describeToken(this.peek())}`);
    }
    return expression;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();

    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.previousOperator("additive");
      const right = this.parseMultiplicative();
      left = { kind: "binary", operator, left, right };
    }

    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parsePower();

    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = this.previousOperator("multiplicative");
      const right = this.parsePower();
      left = { kind: "binary", operator, left, right };
    }

    return left;
  }

  private parsePower(): Expression {
    const left = this.parseUnary();
    if (this.matchOperator("^")) {
      return {
        kind: "binary",
        operator: "^",
        left,
        right: this.parsePower(),
      };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.previousOperator("unary");
      if (operator !== "+" && operator !== "-") {
        throw new Error("Invalid unary operator");
      }
      return {
        kind: "unary",
        operator,
        operand: this.parseUnary(),
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.advance();
    if (!token) {
      throw new Error("Unexpected end of formula");
    }

    if (token.kind === "number") {
      return { kind: "number", value: token.value };
    }

    if (token.kind === "identifier") {
      if (token.value === "exp" || token.value === "sqrt") {
        this.consume("leftParen", `Expected '(' after ${token.value}`);
        const argument = this.parseAdditive();
        this.consume(
          "rightParen",
          `Expected ')' after ${token.value} argument`,
        );
        return { kind: "function", name: token.value, argument };
      }

      if (!isCatalogVariable(token.value)) {
        throw new Error(`Unknown formula variable "${token.value}"`);
      }
      return { kind: "variable", name: token.value };
    }

    if (token.kind === "leftParen") {
      const expression = this.parseAdditive();
      this.consume("rightParen", "Expected ')' after grouped expression");
      return expression;
    }

    throw new Error(`Unexpected token ${describeToken(token)}`);
  }

  private matchOperator(
    operator: "+" | "-" | "*" | "/" | "^",
  ): boolean {
    const token = this.peek();
    if (token?.kind !== "operator" || token.value !== operator) {
      return false;
    }
    this.position += 1;
    return true;
  }

  private previousOperator(
    context: string,
  ): "+" | "-" | "*" | "/" | "^" {
    const token = this.tokens[this.position - 1];
    if (token?.kind !== "operator") {
      throw new Error(`Missing ${context} operator`);
    }
    return token.value;
  }

  private consume(kind: Token["kind"], message: string): void {
    if (this.peek()?.kind !== kind) {
      throw new Error(message);
    }
    this.position += 1;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private advance(): Token | undefined {
    const token = this.peek();
    if (token) {
      this.position += 1;
    }
    return token;
  }
}

function isCatalogVariable(value: string): value is CatalogFormulaVariable {
  return catalogFormulaVariables.includes(value as CatalogFormulaVariable);
}

function evaluate(
  expression: Expression,
  inputs: CatalogFormulaInputs,
): Decimal {
  switch (expression.kind) {
    case "number":
      return new Decimal(expression.value);
    case "variable": {
      const input = inputs[expression.name];
      if (input === undefined || input === null || input === "") {
        throw new Error(`Missing value for ${expression.name}`);
      }
      const value = new Decimal(input);
      if (!value.isFinite()) {
        throw new Error(`Value for ${expression.name} is not finite`);
      }
      return value;
    }
    case "unary": {
      const operand = evaluate(expression.operand, inputs);
      return expression.operator === "-" ? operand.negated() : operand;
    }
    case "binary": {
      const left = evaluate(expression.left, inputs);
      const right = evaluate(expression.right, inputs);
      switch (expression.operator) {
        case "+":
          return left.plus(right);
        case "-":
          return left.minus(right);
        case "*":
          return left.times(right);
        case "/":
          if (right.isZero()) {
            throw new Error("Division by zero");
          }
          return left.dividedBy(right);
        case "^":
          return left.pow(right);
      }
    }
    case "function": {
      const argument = evaluate(expression.argument, inputs);
      if (expression.name === "sqrt") {
        if (argument.isNegative()) {
          throw new Error("Square root of a negative value");
        }
        return argument.sqrt();
      }
      return Decimal.exp(argument);
    }
  }
}

function describeToken(token: Token | undefined): string {
  if (!token) {
    return "at end of formula";
  }
  if ("value" in token) {
    return JSON.stringify(token.value);
  }
  return token.kind;
}
