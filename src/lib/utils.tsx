import { clsx, type ClassValue } from "clsx";
import type * as React from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const SQL_KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "CHECK", "COLUMN",
  "CONSTRAINT", "CREATE", "CROSS", "DEFAULT", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END",
  "EXCEPT", "EXISTS", "FALSE", "FOREIGN", "FROM", "FULL", "GROUP", "HAVING", "IF", "IN", "INDEX",
  "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "KEY", "LEFT", "LIKE", "LIMIT", "NOT",
  "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "PRIMARY", "REFERENCES", "RIGHT", "SELECT",
  "SET", "TABLE", "THEN", "TO", "TRUE", "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "VIEW",
  "WHEN", "WHERE", "WITH",
]);

type SqlToken = { text: string; kind: "keyword" | "string" | "number" | "comment" | "plain" };

const TOKEN_CLASS: Record<SqlToken["kind"], string> = {
  keyword: "text-sql-keyword font-semibold",
  string: "text-sql-string",
  number: "text-sql-number",
  comment: "text-sql-comment italic",
  plain: "text-foreground",
};

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      tokens.push({ text: sql.slice(i, end === -1 ? sql.length : end), kind: "comment" });
      i = end === -1 ? sql.length : end;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && sql[j] !== "'") {
        if (sql[j] === "\\") j++;
        j++;
      }
      tokens.push({ text: sql.slice(i, Math.min(j + 1, sql.length)), kind: "string" });
      i = Math.min(j + 1, sql.length);
      continue;
    }

    if (/\d/.test(sql[i]) && (i === 0 || /[\s"'(]/.test(sql[i - 1]))) {
      const match = sql.slice(i).match(/^\d+(\.\d+)?/);
      if (match) {
        tokens.push({ text: match[0], kind: "number" });
        i += match[0].length;
        continue;
      }
    }

    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      tokens.push({ text: word, kind: SQL_KEYWORDS.has(word.toUpperCase()) ? "keyword" : "plain" });
      i = j;
      continue;
    }

    tokens.push({ text: sql[i], kind: "plain" });
    i++;
  }

  return tokens;
}

export function highlightSql(sql: string): React.JSX.Element {
  return (
    <>
      {tokenizeSql(sql).map((token, idx) => (
        <span className={TOKEN_CLASS[token.kind]} key={idx}>
          {token.text}
        </span>
      ))}
    </>
  );
}
