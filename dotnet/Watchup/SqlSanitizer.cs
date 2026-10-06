// ─────────────────────────────────────────────────────────────────────────────
// Watchup .NET SDK  ·  SQL statement sanitizer for database spans
// ─────────────────────────────────────────────────────────────────────────────

using System.Text.RegularExpressions;

namespace Watchup;

/// <summary>
/// Replaces literals with <c>?</c> and caps statements at 1 KiB, so database span
/// names never carry credentials or parameter values.
/// </summary>
public static class SqlSanitizer
{
    public const int MaxStatementBytes = 1024;

    private static readonly (Regex Pattern, string Replacement)[] Rules =
    {
        (new Regex(@"--[^\n]*", RegexOptions.Compiled), " "),
        (new Regex(@"/\*[\s\S]*?\*/", RegexOptions.Compiled), " "),
        (new Regex(@"'(?:[^']|'')*'", RegexOptions.Compiled), "?"),
        (new Regex(@"\$\$[\s\S]*?\$\$", RegexOptions.Compiled), "?"),
        (new Regex(@"\b0x[0-9a-f]+\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "?"),
        (new Regex(@"(^|[^\w$@])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b", RegexOptions.Compiled | RegexOptions.IgnoreCase), "$1?"),
        (new Regex(@"\(\s*\?(?:\s*,\s*\?)+\s*\)", RegexOptions.Compiled), "(?)"),
        (new Regex(@"\s+", RegexOptions.Compiled), " "),
    };

    public static string Sanitize(string sql)
    {
        var output = sql;
        foreach (var (pattern, replacement) in Rules) output = pattern.Replace(output, replacement);
        return Contract.TruncateUtf8(output.Trim(), MaxStatementBytes).Value;
    }
}
