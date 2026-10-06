package watchup

// Transport contract (spec/README.md): limits, normalization and redaction,
// truncation, and the byte-aware chunker. Mirrors @watchupltd/core; the shared
// vectors in spec/fixtures/vectors.json run against this file in
// vectors_test.go.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Contract limits. See spec/README.md §3.
const (
	ContractVersion = 1

	MaxChunkBytes   = 196_608
	MaxChunkItems   = 100
	BeaconMaxBytes  = 61_440
	MaxQueueItems   = 1_000
	MaxAttempts     = 5
	BaseBackoffMS   = 1_000
	MaxBackoffMS    = 30_000
	MaxRetryAfterMS = 60_000
	MaxRetryChunks  = 50

	TruncateMessageBytes      = 8_192
	TruncateStackBytes        = 32_768
	TruncateFieldBytes        = 8_192
	TruncateMessageFinalBytes = 1_024
	TruncateStackFinalBytes   = 4_096

	MaxDepth = 10
	MaxKeys  = 200
	MaxArray = 200

	Redacted   = "[REDACTED]"
	ingestPath = "/api/v1/ingest/batch"
)

// DefaultBaseURL is the production WatchUp API.
const DefaultBaseURL = "https://api.watchup.site"

var kinds = [3]string{"errors", "traces", "events"}

// ── JSON / UTF-8 ─────────────────────────────────────────────────────────────

// marshal produces compact JSON without HTML escaping, so byte counts match the
// body that is sent.
func marshal(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

func truncateUTF8(s string, maxBytes int) (string, int) {
	if len(s) <= maxBytes {
		return s, 0
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], len(s) - cut
}

func truncateWithMarker(s string, maxBytes int) (string, bool) {
	kept, removed := truncateUTF8(s, maxBytes)
	if removed == 0 {
		return s, false
	}
	return fmt.Sprintf("%s…[truncated %d bytes]", kept, removed), true
}

// ── Redaction ────────────────────────────────────────────────────────────────

var sensitiveKeys = map[string]bool{
	"authorization": true, "proxyauthorization": true, "cookie": true, "setcookie": true,
	"password": true, "passwd": true, "pwd": true, "secret": true, "clientsecret": true,
	"apikey": true, "xapikey": true, "apisecret": true, "privatekey": true,
	"creditcard": true, "cardnumber": true, "ccnumber": true, "cvv": true, "cvc": true,
	"ssn": true, "sessiontoken": true,
}

var keyStrip = strings.NewReplacer("-", "", "_", "", ".", "", " ", "")

func canonicalKey(k string) string { return keyStrip.Replace(strings.ToLower(k)) }

// IsSensitiveKey reports whether values stored under key are redacted.
func IsSensitiveKey(key string, extra map[string]bool) bool {
	k := canonicalKey(key)
	if sensitiveKeys[k] || extra[k] || strings.HasSuffix(k, "token") {
		return true
	}
	return strings.Contains(k, "password") || strings.Contains(k, "secret") || strings.Contains(k, "credential")
}

var (
	authScheme     = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*`)
	liveKey        = regexp.MustCompile(`\bwup_live_[A-Za-z0-9]+`)
	sensitiveQuery = regexp.MustCompile(`(?i)([?&](?:token|access_token|password|api_key|apikey|secret|key)=)[^&#\s"']*`)
	cardCandidate  = regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`)
	fourDigits     = regexp.MustCompile(`\d{4}`)
)

func luhn(digits string) bool {
	sum, double := 0, false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}

// ScrubString removes credentials and card numbers embedded in free text.
func ScrubString(s string) string {
	if len(s) < 8 {
		return s
	}
	out := s
	lower := strings.ToLower(out)
	if strings.Contains(lower, "bearer") || strings.Contains(lower, "basic") {
		out = authScheme.ReplaceAllString(out, "${1} "+Redacted)
	}
	if strings.Contains(out, "wup_live_") {
		out = liveKey.ReplaceAllString(out, Redacted)
	}
	if strings.Contains(out, "=") {
		out = sensitiveQuery.ReplaceAllString(out, "${1}"+Redacted)
	}
	if fourDigits.MatchString(out) {
		out = cardCandidate.ReplaceAllStringFunc(out, func(m string) string {
			digits := strings.NewReplacer(" ", "", "-", "").Replace(m)
			if len(digits) >= 13 && len(digits) <= 19 && luhn(digits) {
				return Redacted
			}
			return m
		})
	}
	return out
}

type omit struct{}

// Normalize converts v into JSON-safe data (maps, slices, strings, numbers,
// bools, nil) and redacts it. It never panics.
func Normalize(v any, redactKeys []string) (out any) {
	extra := map[string]bool{}
	for _, k := range redactKeys {
		extra[canonicalKey(k)] = true
	}
	defer func() {
		if recover() != nil {
			out = "[Unserializable]"
		}
	}()
	r := walk(v, 0, extra, map[uintptr]bool{})
	if _, skip := r.(omit); skip {
		return nil
	}
	return r
}

func cleanString(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	return ScrubString(s)
}

func walk(v any, depth int, extra map[string]bool, seen map[uintptr]bool) any {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return cleanString(t)
	case bool:
		return t
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case float32:
		return walk(float64(t), depth, extra, seen)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, json.Number:
		return t
	case time.Time:
		return t.UTC().Format(time.RFC3339Nano)
	case time.Duration:
		return t.String()
	case []byte:
		return fmt.Sprintf("[Binary %d bytes]", len(t))
	case error:
		return map[string]any{"name": fmt.Sprintf("%T", t), "message": cleanString(t.Error())}
	case fmt.Stringer:
		rv := reflect.ValueOf(v)
		if rv.Kind() != reflect.Map && rv.Kind() != reflect.Slice && rv.Kind() != reflect.Struct {
			return cleanString(t.String())
		}
	}

	if depth >= MaxDepth {
		return "[MaxDepth]"
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Func, reflect.Chan, reflect.UnsafePointer:
		return omit{}
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		if rv.Kind() == reflect.Pointer {
			p := rv.Pointer()
			if seen[p] {
				return "[Circular]"
			}
			seen[p] = true
			defer delete(seen, p)
		}
		return walk(rv.Elem().Interface(), depth, extra, seen)
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		p := rv.Pointer()
		if seen[p] {
			return "[Circular]"
		}
		seen[p] = true
		defer delete(seen, p)
		keys := make([]string, 0, rv.Len())
		values := map[string]reflect.Value{}
		for _, k := range rv.MapKeys() {
			name := fmt.Sprint(k.Interface())
			keys = append(keys, name)
			values[name] = rv.MapIndex(k)
		}
		sort.Strings(keys)
		out := map[string]any{}
		kept := 0
		for _, name := range keys {
			if kept >= MaxKeys {
				out["_watchup_dropped_keys"] = len(keys) - kept
				break
			}
			if IsSensitiveKey(name, extra) {
				out[name] = Redacted
				kept++
				continue
			}
			nv := walk(values[name].Interface(), depth+1, extra, seen)
			if _, skip := nv.(omit); skip {
				continue
			}
			out[name] = nv
			kept++
		}
		return out
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return nil
		}
		n := rv.Len()
		limit := n
		if limit > MaxArray {
			limit = MaxArray
		}
		out := make([]any, 0, limit+1)
		for i := 0; i < limit; i++ {
			nv := walk(rv.Index(i).Interface(), depth+1, extra, seen)
			if _, skip := nv.(omit); skip {
				nv = nil
			}
			out = append(out, nv)
		}
		if n > limit {
			out = append(out, fmt.Sprintf("[… %d more]", n-limit))
		}
		return out
	case reflect.Struct:
		// Respect json tags by round-tripping through encoding/json.
		raw, err := json.Marshal(v)
		if err != nil {
			return "[Unserializable]"
		}
		var generic any
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&generic); err != nil {
			return "[Unserializable]"
		}
		return walk(generic, depth, extra, seen)
	case reflect.String:
		return cleanString(rv.String())
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint()
	case reflect.Float32, reflect.Float64:
		return walk(rv.Float(), depth, extra, seen)
	}
	return cleanString(fmt.Sprint(v))
}

// ── Truncation (spec §5) ─────────────────────────────────────────────────────

var containers = []string{"context", "meta", "properties"}

func capStrings(v any, maxBytes int) (any, bool) {
	switch t := v.(type) {
	case string:
		return truncateWithMarker(t, maxBytes)
	case []any:
		changed := false
		out := make([]any, len(t))
		for i, x := range t {
			nv, c := capStrings(x, maxBytes)
			changed = changed || c
			out[i] = nv
		}
		return out, changed
	case map[string]any:
		changed := false
		out := make(map[string]any, len(t))
		for k, x := range t {
			nv, c := capStrings(x, maxBytes)
			changed = changed || c
			out[k] = nv
		}
		return out, changed
	}
	return v, false
}

func capField(item map[string]any, field string, maxBytes int) bool {
	s, ok := item[field].(string)
	if !ok {
		return false
	}
	ns, changed := truncateWithMarker(s, maxBytes)
	if changed {
		item[field] = ns
	}
	return changed
}

type fitResult struct {
	json      string
	truncated bool
	oversized bool
}

func fitItem(item map[string]any, budget int) (fitResult, error) {
	encoded, err := marshal(item)
	if err != nil {
		return fitResult{}, err
	}
	if len(encoded) <= budget {
		return fitResult{json: encoded}, nil
	}

	out := make(map[string]any, len(item)+1)
	for k, v := range item {
		out[k] = v
	}
	truncated := false
	truncated = capField(out, "message", TruncateMessageBytes) || truncated
	truncated = capField(out, "stack", TruncateStackBytes) || truncated
	for _, key := range containers {
		if v, ok := out[key]; ok {
			if nv, changed := capStrings(v, TruncateFieldBytes); changed {
				out[key] = nv
				truncated = true
			}
		}
	}
	out["_watchup_truncated"] = true
	encoded, _ = marshal(out)

	if len(encoded) > budget {
		for _, key := range containers {
			if v, ok := item[key]; ok {
				original, _ := marshal(v)
				out[key] = map[string]any{"_watchup_truncated": true, "original_bytes": len(original)}
				truncated = true
			}
		}
		encoded, _ = marshal(out)
	}
	if len(encoded) > budget {
		truncated = capField(out, "message", TruncateMessageFinalBytes) || truncated
		truncated = capField(out, "stack", TruncateStackFinalBytes) || truncated
		encoded, _ = marshal(out)
	}
	if !truncated {
		delete(out, "_watchup_truncated")
		encoded, _ = marshal(out)
	}
	return fitResult{json: encoded, truncated: truncated, oversized: len(encoded) > budget}, nil
}

// ── Chunker (spec §4) ────────────────────────────────────────────────────────

type preparedItem struct {
	kind string
	json string
}

// Chunk is one request body, ready to send or retry.
type Chunk struct {
	IdempotencyKey string
	Body           string
	Counts         map[string]int
	Attempts       int
	nextAttemptAt  time.Time
}

// Items is the number of items in the chunk.
func (c *Chunk) Items() int { return c.Counts["errors"] + c.Counts["traces"] + c.Counts["events"] }

var prefix = [4]string{`{"errors":[`, `],"traces":[`, `],"events":[`, `],`}

func tail(base map[string]any, key, sentAt string) string {
	m := make(map[string]any, len(base)+2)
	for k, v := range base {
		m[k] = v
	}
	m["idempotency_key"] = key
	m["sent_at"] = sentAt
	s, _ := marshal(m)
	return s[1:]
}

func envelopeOverhead(base map[string]any) int {
	worst := "wu_" + strings.Repeat("0", 36) + "_999999"
	return len(strings.Join(prefix[:], "")) + len(tail(base, worst, "2026-01-01T00:00:00.000Z"))
}

func buildChunks(pending map[string][]preparedItem, base map[string]any, maxBytes, maxItems int, batchID, sentAt string) []*Chunk {
	overhead := envelopeOverhead(base)
	var chunks []*Chunk
	groups := map[string][]string{}
	size, count := overhead, 0

	closeChunk := func() {
		if count == 0 {
			return
		}
		key := fmt.Sprintf("wu_%s_%d", batchID, len(chunks))
		body := prefix[0] + strings.Join(groups["errors"], ",") +
			prefix[1] + strings.Join(groups["traces"], ",") +
			prefix[2] + strings.Join(groups["events"], ",") +
			prefix[3] + tail(base, key, sentAt)
		chunks = append(chunks, &Chunk{
			IdempotencyKey: key,
			Body:           body,
			Counts:         map[string]int{"errors": len(groups["errors"]), "traces": len(groups["traces"]), "events": len(groups["events"])},
		})
		groups = map[string][]string{}
		size, count = overhead, 0
	}

	for _, kind := range kinds {
		for _, item := range pending[kind] {
			added := len(item.json)
			if len(groups[kind]) > 0 {
				added++
			}
			if count > 0 && (size+added > maxBytes || count+1 > maxItems) {
				closeChunk()
				added = len(item.json)
			}
			groups[kind] = append(groups[kind], item.json)
			size += added
			count++
			if size > maxBytes {
				closeChunk()
			}
		}
	}
	closeChunk()
	return chunks
}

func isRetryableStatus(status int) bool {
	return status == 408 || status == 425 || status == 429 || status >= 500
}
