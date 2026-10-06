package watchup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

type vectorFile struct {
	Constants   map[string]any   `json:"constants"`
	SDK         map[string]any   `json:"sdk"`
	Chunking    []map[string]any `json:"chunking"`
	Redaction   []map[string]any `json:"redaction"`
	FlagBuckets []struct {
		Flag   string `json:"flag"`
		ID     string `json:"id"`
		Bucket int    `json:"bucket"`
	} `json:"flag_buckets"`
	Delivery []map[string]any `json:"delivery"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "spec", "fixtures", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func expand(v any, i int) any {
	switch t := v.(type) {
	case string:
		return strings.ReplaceAll(t, "{i}", fmt.Sprint(i))
	case []any:
		out := make([]any, len(t))
		for j, x := range t {
			out[j] = expand(x, i)
		}
		return out
	case map[string]any:
		if rep, ok := t["$repeat"]; ok {
			return strings.Repeat(rep.(string), int(t["times"].(float64)))
		}
		if obj, ok := t["$object"].(map[string]any); ok {
			out := map[string]any{}
			for j := 0; j < int(obj["count"].(float64)); j++ {
				out[strings.ReplaceAll(obj["key"].(string), "{j}", fmt.Sprint(j))] = expand(obj["value"], i)
			}
			return out
		}
		out := map[string]any{}
		for k, x := range t {
			out[k] = expand(x, i)
		}
		return out
	}
	return v
}

func vectorInput(vector map[string]any) map[string][]map[string]any {
	out := map[string][]map[string]any{}
	for _, kind := range kinds {
		if input, ok := vector["input"].(map[string]any); ok {
			list, _ := input[kind].([]any)
			for _, it := range list {
				out[kind] = append(out[kind], it.(map[string]any))
			}
		}
		if gen, ok := vector["generate"].(map[string]any); ok {
			if g, ok := gen[kind].(map[string]any); ok {
				for i := 0; i < int(g["count"].(float64)); i++ {
					out[kind] = append(out[kind], expand(g["template"], i).(map[string]any))
				}
			}
		}
	}
	return out
}

func label(kind string, item map[string]any) string {
	field := map[string]string{"errors": "message", "traces": "span", "events": "name"}[kind]
	return kind + ":" + fmt.Sprint(item[field])
}

type harness struct {
	q          *deliveryQueue
	mu         sync.Mutex
	sent       []*Chunk
	attempts   []struct{ key, body string }
	diagnostic []string
	script     []int
	mode       string
	clock      time.Time
}

func newHarness(responses any, maxItems int, sdk map[string]any) *harness {
	h := &harness{clock: time.Unix(1_700_000_000, 0)}
	switch r := responses.(type) {
	case []any:
		h.script = []int{}
		for _, s := range r {
			h.script = append(h.script, int(s.(float64)))
		}
	case string:
		h.mode = r
	}
	h.q = newDeliveryQueue(queueOptions{
		send: func(_ context.Context, c *Chunk) SendResult {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.attempts = append(h.attempts, struct{ key, body string }{c.IdempotencyKey, c.Body})
			status := 200
			if h.script != nil {
				if len(h.script) > 0 {
					status, h.script = h.script[0], h.script[1:]
				}
			} else if h.mode == "always_503" {
				status = 503
			}
			if status < 300 {
				h.sent = append(h.sent, c)
				return SendResult{OK: true, Status: status}
			}
			return SendResult{Status: status}
		},
		base:          func() map[string]any { return map[string]any{"sdk": sdk, "environment": "test"} },
		maxItems:      maxItems,
		maxQueueItems: 10_000,
		onDiagnostic: func(d Diagnostic) {
			h.mu.Lock()
			h.diagnostic = append(h.diagnostic, d.Type)
			h.mu.Unlock()
		},
		now:    func() time.Time { return h.clock },
		random: func() float64 { return 0 },
	})
	return h
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestConstantsMatchSpec(t *testing.T) {
	v := loadVectors(t)
	got := map[string]any{
		"MAX_CHUNK_BYTES": MaxChunkBytes, "MAX_CHUNK_ITEMS": MaxChunkItems, "BEACON_MAX_BYTES": BeaconMaxBytes,
		"MAX_QUEUE_ITEMS": MaxQueueItems, "MAX_ATTEMPTS": MaxAttempts, "BASE_BACKOFF_MS": BaseBackoffMS,
		"MAX_BACKOFF_MS": MaxBackoffMS, "MAX_RETRY_AFTER_MS": MaxRetryAfterMS,
		"TRUNCATE_MESSAGE_BYTES": TruncateMessageBytes, "TRUNCATE_STACK_BYTES": TruncateStackBytes,
		"TRUNCATE_FIELD_BYTES": TruncateFieldBytes, "TRUNCATE_MESSAGE_FINAL_BYTES": TruncateMessageFinalBytes,
		"TRUNCATE_STACK_FINAL_BYTES": TruncateStackFinalBytes, "MAX_DEPTH": MaxDepth, "MAX_KEYS": MaxKeys,
		"MAX_ARRAY": MaxArray, "REDACTED": Redacted,
	}
	for k, want := range v.Constants {
		if fmt.Sprint(got[k]) != fmt.Sprint(want) {
			t.Errorf("%s = %v, spec says %v", k, got[k], want)
		}
	}
}

func TestChunkingVectors(t *testing.T) {
	v := loadVectors(t)
	marker := regexp.MustCompile(`…\[truncated \d+ bytes\]$`)
	for _, vector := range v.Chunking {
		vector := vector
		t.Run(vector["name"].(string), func(t *testing.T) {
			maxItems := 0
			if o, ok := vector["options"].(map[string]any); ok {
				maxItems = int(o["max_items"].(float64))
			}
			h := newHarness("always_200", maxItems, v.SDK)
			input := vectorInput(vector)
			for _, kind := range kinds {
				for _, item := range input[kind] {
					h.q.enqueue(kind, item)
				}
			}
			h.q.flush(context.Background(), false)
			expect := vector["expect"].(map[string]any)

			if len(h.sent) != int(expect["chunks"].(float64)) {
				t.Fatalf("chunks = %d, want %v", len(h.sent), expect["chunks"])
			}
			type entry struct {
				kind string
				item map[string]any
			}
			var order []entry
			var sequence [][]string
			var perChunk []int
			for _, c := range h.sent {
				if len(c.Body) > MaxChunkBytes {
					t.Fatalf("chunk %d bytes > limit", len(c.Body))
				}
				var body map[string]any
				if err := json.Unmarshal([]byte(c.Body), &body); err != nil {
					t.Fatal(err)
				}
				var labels []string
				n := 0
				for _, kind := range kinds {
					for _, it := range body[kind].([]any) {
						m := it.(map[string]any)
						order = append(order, entry{kind, m})
						labels = append(labels, label(kind, m))
						n++
					}
				}
				if n > MaxChunkItems {
					t.Fatalf("%d items in a chunk", n)
				}
				if !regexp.MustCompile(`^wu_[A-Za-z0-9-]+_\d+$`).MatchString(body["idempotency_key"].(string)) {
					t.Fatalf("bad key %v", body["idempotency_key"])
				}
				sequence = append(sequence, labels)
				perChunk = append(perChunk, n)
			}
			if want, ok := expect["items_per_chunk"].([]any); ok {
				if fmt.Sprint(perChunk) != fmt.Sprint(toInts(want)) {
					t.Fatalf("items per chunk %v, want %v", perChunk, want)
				}
			}
			if want, ok := expect["sequence"].([]any); ok {
				var w [][]string
				for _, row := range want {
					var r []string
					for _, s := range row.([]any) {
						r = append(r, s.(string))
					}
					w = append(w, r)
				}
				if !reflect.DeepEqual(sequence, w) {
					t.Fatalf("sequence %v, want %v", sequence, w)
				}
			}
			if want, ok := expect["truncated"].([]any); ok {
				for i, e := range order {
					got := e.item["_watchup_truncated"] == true
					if got != want[i].(bool) {
						t.Fatalf("item %d truncated=%v want %v", i, got, want[i])
					}
				}
			}
			if max, ok := expect["max_message_bytes"].(float64); ok {
				for _, e := range order {
					msg := e.item["message"].(string)
					if !marker.MatchString(msg) || len(marker.ReplaceAllString(msg, "")) > int(max) {
						t.Fatalf("message not truncated correctly (%d bytes)", len(msg))
					}
					if !utf8.ValidString(msg) || strings.ContainsRune(msg, utf8.RuneError) {
						t.Fatal("invalid UTF-8 after truncation")
					}
				}
			}
			if expect["context_marker"] == true {
				ctx := order[0].item["context"].(map[string]any)
				if ctx["_watchup_truncated"] != true || ctx["original_bytes"].(float64) <= MaxChunkBytes {
					t.Fatalf("context marker wrong: %v", ctx)
				}
			}
			if want, ok := expect["diagnostics"].([]any); ok {
				for _, d := range want {
					if !contains(h.diagnostic, d.(string)) {
						t.Fatalf("missing diagnostic %v in %v", d, h.diagnostic)
					}
				}
			}
		})
	}
}

func toInts(list []any) []int {
	out := make([]int, len(list))
	for i, x := range list {
		out[i] = int(x.(float64))
	}
	return out
}

func TestRedactionVectors(t *testing.T) {
	v := loadVectors(t)
	for _, vector := range v.Redaction {
		got := Normalize(vector["input"], nil)
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(vector["expected"])
		if string(gotJSON) != string(wantJSON) {
			t.Fatalf("%s:\n got %s\nwant %s", vector["name"], gotJSON, wantJSON)
		}
	}
}

func TestFlagBucketVectors(t *testing.T) {
	for _, fb := range loadVectors(t).FlagBuckets {
		if got := FlagBucket(fb.Flag, fb.ID); got != fb.Bucket {
			t.Errorf("FlagBucket(%q, %q) = %d, want %d", fb.Flag, fb.ID, got, fb.Bucket)
		}
	}
}

func TestDeliveryVectors(t *testing.T) {
	v := loadVectors(t)
	for _, vector := range v.Delivery {
		vector := vector
		t.Run(vector["name"].(string), func(t *testing.T) {
			h := newHarness(vector["responses"], 0, v.SDK)
			n := 0
			items := vector["items"].(map[string]any)
			for _, kind := range kinds {
				count, _ := items[kind].(float64)
				for i := 0; i < int(count); i++ {
					id := fmt.Sprintf("%s-%d", kind, n)
					n++
					switch kind {
					case "errors":
						h.q.enqueue(kind, map[string]any{"message": id, "level": "error", "timestamp": "t"})
					case "traces":
						h.q.enqueue(kind, map[string]any{"span": id, "ms": 1, "status_code": 200, "status": "ok", "timestamp": "t"})
					default:
						h.q.enqueue(kind, map[string]any{"name": id, "occurred_at": "t"})
					}
				}
			}
			name := vector["name"].(string)
			switch {
			case strings.HasPrefix(name, "shutdown"):
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if name == "shutdown_reports_undelivered" {
					cancel()
					ctx, cancel = context.WithTimeout(context.Background(), 0)
				}
				h.q.shutdown(ctx)
				cancel()
			case vector["concurrent_flushes"] != nil:
				var wg sync.WaitGroup
				for i := 0; i < int(vector["concurrent_flushes"].(float64)); i++ {
					wg.Add(1)
					go func() { defer wg.Done(); h.q.flush(context.Background(), false) }()
				}
				wg.Wait()
			default:
				h.q.flush(context.Background(), false)
				for i := 0; i < 10; i++ {
					if _, retrying := h.q.counts(); retrying == 0 {
						break
					}
					h.q.flush(context.Background(), true)
				}
			}

			expect := vector["expect"].(map[string]any)
			var delivered []string
			for _, c := range h.sent {
				var body map[string]any
				_ = json.Unmarshal([]byte(c.Body), &body)
				for _, kind := range kinds {
					for _, it := range body[kind].([]any) {
						delivered = append(delivered, label(kind, it.(map[string]any)))
					}
				}
			}
			if len(delivered) != int(expect["delivered_items"].(float64)) {
				t.Fatalf("delivered %d, want %v", len(delivered), expect["delivered_items"])
			}
			if u, ok := expect["unique_items"].(float64); ok {
				seen := map[string]bool{}
				for _, d := range delivered {
					seen[d] = true
				}
				if len(seen) != int(u) {
					t.Fatalf("unique %d want %v", len(seen), u)
				}
			}
			if a, ok := expect["attempts"].(float64); ok && len(h.attempts) != int(a) {
				t.Fatalf("attempts %d want %v", len(h.attempts), a)
			}
			if expect["same_idempotency_key"] == true {
				for _, a := range h.attempts {
					if a.key != h.attempts[0].key {
						t.Fatal("idempotency key changed between retries")
					}
				}
			}
			if expect["retried_key_equals_first_key"] == true && h.attempts[2].key != h.attempts[0].key {
				t.Fatal("retry did not reuse the first key")
			}
			if expect["first_pass_keys_distinct"] == true && h.attempts[0].key == h.attempts[1].key {
				t.Fatal("chunks share a key")
			}
			if p, ok := expect["pending_after_shutdown"].(float64); ok {
				pending, retrying := h.q.counts()
				if pending+retrying != int(p) {
					t.Fatalf("pending after shutdown %d", pending+retrying)
				}
			}
			if want, ok := expect["diagnostics"].([]any); ok {
				for _, d := range want {
					if !contains(h.diagnostic, d.(string)) {
						t.Fatalf("missing diagnostic %v in %v", d, h.diagnostic)
					}
				}
			}
			bodies := map[string]string{}
			for _, a := range h.attempts {
				if prev, ok := bodies[a.key]; ok && prev != a.body {
					t.Fatal("retry body differs")
				}
				bodies[a.key] = a.body
			}
		})
	}
}
