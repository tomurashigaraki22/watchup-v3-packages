package watchup

import (
	"regexp"
	"strings"
)

// MaxStatementBytes caps sanitized SQL span names.
const MaxStatementBytes = 1024

var sqlRules = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`--[^\n]*`), " "},
	{regexp.MustCompile(`/\*[\s\S]*?\*/`), " "},
	{regexp.MustCompile(`'(?:[^']|'')*'`), "?"},
	{regexp.MustCompile(`\$\$[\s\S]*?\$\$`), "?"},
	{regexp.MustCompile(`(?i)\b0x[0-9a-f]+\b`), "?"},
	{regexp.MustCompile(`(?i)(^|[^\w$])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b`), "${1}?"},
	{regexp.MustCompile(`\(\s*\?(?:\s*,\s*\?)+\s*\)`), "(?)"},
	{regexp.MustCompile(`\s+`), " "},
}

// SanitizeSQL replaces literals with ? and caps the statement at 1 KiB, so
// database span names never carry credentials or parameter values.
func SanitizeSQL(sql string) string {
	out := sql
	for _, rule := range sqlRules {
		out = rule.re.ReplaceAllString(out, rule.with)
	}
	out, _ = truncateUTF8(strings.TrimSpace(out), MaxStatementBytes)
	return out
}
