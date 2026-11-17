/**
 * security/injectionSignatures.js — pure helpers for the injection executor.
 *
 * SQL error signatures: when a mutated input makes the backend leak a SQL
 * error, the response body identifies the engine (SQLite, MySQL, PostgreSQL,
 * MSSQL, Oracle, Sequelize, …). Signature detection is one of the strongest
 * injection signals — a 500 whose body says "SQLITE_ERROR: near" is not
 * application behavior, it is the database talking to the client.
 */

export const SQL_ERROR_SIGNATURES = [
  { vendor: 'sqlite',    re: /SQLITE_(?:ERROR|CONSTRAINT|SYNTAX|IOERR)/i },
  { vendor: 'sqlite',    re: /SqliteException|sqlite3\.(?:js|DatabaseError)/i },
  { vendor: 'mysql',     re: /You have an error in your SQL syntax|MySQLSyntaxError|ER_(?:PARSE|BAD_FIELD)_ERROR/i },
  { vendor: 'postgres',  re: /PG::(?:SyntaxError|InvalidTextRepresentation|UndefinedTable)|org\.postgresql\.util\.PSQLException/i },
  { vendor: 'mssql',     re: /Unclosed quotation mark after the character string|Microsoft SQL Server|SqlException/i },
  { vendor: 'oracle',    re: /ORA-\d{5}/i },
  { vendor: 'sequelize', re: /SequelizeDatabaseError/i },
  { vendor: 'generic',   re: /SQL syntax|SQLSTATE\[/i },
];

/**
 * Match a SQL error signature in a response body.
 * @returns {{ vendor: string, match: string } | null}
 */
export function matchSqlError(text) {
  const s = String(text || '');
  for (const { vendor, re } of SQL_ERROR_SIGNATURES) {
    const m = s.match(re);
    if (m) return { vendor, match: m[0] };
  }
  return null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/**
 * True when the hostname is loopback. Loopback targets are the developer's
 * own machine — injection probing runs there by default. Non-loopback
 * targets (staging, public demos) require explicit authorization.
 */
export function isLocalhostHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

/** True when the URL parses and points at a loopback host. */
export function isLoopbackUrl(url) {
  try {
    return isLocalhostHost(new URL(url).hostname);
  } catch {
    return false;
  }
}
