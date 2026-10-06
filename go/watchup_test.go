package watchup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type ingest struct {
	mu      sync.Mutex
	bodies  []map[string]any
	headers []http.Header
	status  []int
	srv     *httptest.Server
}

func newIngest(t *testing.T) *ingest {
	in := &ingest{}
	in.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		in.mu.Lock()
		defer in.mu.Unlock()
		if r.URL.Path == "/api/v1/flags" {
			_, _ = w.Write([]byte(`{"ok":true,"data":{"flags":[{"key":"beta","enabled":true,"rollout_percentage":100,"variants":[],"targeting_rules":[{"attribute":"plan","operator":"in","values":["pro"]}]}]}}`))
			return
		}
		if len(in.status) > 0 {
			code := in.status[0]
			in.status = in.status[1:]
			if code >= 300 {
				w.WriteHeader(code)
				return
			}
		}
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		in.bodies = append(in.bodies, body)
		in.headers = append(in.headers, r.Header.Clone())
		w.WriteHeader(201)
	}))
	t.Cleanup(in.srv.Close)
	return in
}

func (in *ingest) items(kind string) []map[string]any {
	in.mu.Lock()
	defer in.mu.Unlock()
	var out []map[string]any
	for _, b := range in.bodies {
		for _, it := range b[kind].([]any) {
			out = append(out, it.(map[string]any))
		}
	}
	return out
}

func newClient(t *testing.T, in *ingest, mod ...func(*Options)) *Client {
	opts := Options{APIKey: "wup_live_test", BaseURL: in.srv.URL, FlushInterval: time.Hour, FlagRefreshInterval: -1, Release: "r1", Service: "api"}
	for _, m := range mod {
		m(&opts)
	}
	c, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = c.Close(ctx)
	})
	return c
}

func TestNewValidatesOptions(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("expected error without APIKey")
	}
	if _, err := New(Options{APIKey: "k", SampleRate: 2}); err == nil {
		t.Fatal("expected error for SampleRate > 1")
	}
}

func TestEnvelopeHeadersAndErrors(t *testing.T) {
	in := newIngest(t)
	c := newClient(t, in)
	c.CaptureError(context.Background(), errors.New("boom: Bearer abc.def"), map[string]any{"password": "hunter2"})
	c.Flush(context.Background())

	if len(in.bodies) != 1 {
		t.Fatalf("bodies = %d", len(in.bodies))
	}
	body := in.bodies[0]
	if body["sdk"].(map[string]any)["name"] != SDKName || body["release"] != "r1" {
		t.Fatalf("envelope %v", body)
	}
	h := in.headers[0]
	if h.Get("Idempotency-Key") != body["idempotency_key"] || h.Get("Authorization") != "Bearer wup_live_test" {
		t.Fatalf("headers %v", h)
	}
	errItem := in.items("errors")[0]
	raw, _ := json.Marshal(errItem)
	if strings.Contains(string(raw), "hunter2") || strings.Contains(string(raw), "abc.def") {
		t.Fatalf("secret leaked: %s", raw)
	}
	if errItem["context"].(map[string]any)["service"] != "api" || errItem["stack"] == "" {
		t.Fatalf("context/stack missing: %v", errItem)
	}
}

func TestMiddlewareRoutesStatusPanicsAndUserIsolation(t *testing.T) {
	in := newIngest(t)
	c := newClient(t, in)
	mux := http.NewServeMux()
	mux.HandleFunc("/items/", func(w http.ResponseWriter, r *http.Request) {
		user := r.Header.Get("X-User")
		SetUser(r.Context(), &User{ID: user})
		if user == "slow" {
			time.Sleep(20 * time.Millisecond)
		}
		c.Track(r.Context(), "item.viewed", map[string]any{"expected": user})
		w.Header().Set("X-Kept", "yes")
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("/panic", func(http.ResponseWriter, *http.Request) { panic("kaboom") })
	srv := httptest.NewServer(c.Middleware(mux))
	defer srv.Close()

	var wg sync.WaitGroup
	for _, u := range []string{"slow", "fast"} {
		wg.Add(1)
		go func(u string) {
			defer wg.Done()
			req, _ := http.NewRequest("GET", srv.URL+"/items/42", nil)
			req.Header.Set("X-User", u)
			req.Header.Set("X-Request-ID", "req-"+u)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode != 202 || resp.Header.Get("X-Kept") != "yes" {
				t.Errorf("status %d headers %v", resp.StatusCode, resp.Header)
			}
		}(u)
	}
	wg.Wait()
	// net/http recovers handler panics itself; the middleware re-raises after capture.
	// POST: net/http's client retries an idempotent GET when the connection drops.
	resp, err := http.Post(srv.URL+"/panic", "text/plain", nil)
	if err == nil {
		resp.Body.Close()
	}
	time.Sleep(50 * time.Millisecond)
	c.Flush(context.Background())

	for _, e := range in.items("events") {
		props := e["properties"].(map[string]any)
		if props["user"].(map[string]any)["id"] != props["expected"] {
			t.Fatalf("user leaked across requests: %v", props)
		}
	}
	traces := in.items("traces")
	statuses := map[string]float64{}
	for _, tr := range traces {
		statuses[tr["span"].(string)+"/"+tr["meta"].(map[string]any)["request_id"].(string)] = tr["status_code"].(float64)
		if tr["type"] != "http" {
			t.Fatalf("trace type %v", tr["type"])
		}
	}
	if statuses["GET /items//req-slow"] != 202 && statuses["GET /items/:id/req-slow"] != 202 {
		t.Fatalf("missing 202 trace: %v", statuses)
	}
	errs := in.items("errors")
	if len(errs) != 1 || errs[0]["message"] != "panic: kaboom" || errs[0]["route"] == nil {
		t.Fatalf("panic not captured once: %v", errs)
	}
}

func TestRetryReusesKeyAndCloseReportsUndelivered(t *testing.T) {
	in := newIngest(t)
	in.status = []int{503}
	c := newClient(t, in)
	c.Track(context.Background(), "retry-me", nil)
	c.Flush(context.Background())
	c.queue.flush(context.Background(), true)
	if got := len(in.items("events")); got != 1 {
		t.Fatalf("events = %d", got)
	}

	var diags []string
	var mu sync.Mutex
	down, err := New(Options{APIKey: "k", BaseURL: "http://127.0.0.1:9", FlushInterval: time.Hour, FlagRefreshInterval: -1, Timeout: 200 * time.Millisecond,
		OnDiagnostic: func(d Diagnostic) { mu.Lock(); diags = append(diags, d.Type); mu.Unlock() }})
	if err != nil {
		t.Fatal(err)
	}
	down.Track(context.Background(), "lost", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := down.Close(ctx); err == nil {
		t.Fatal("expected undelivered error")
	}
	mu.Lock()
	defer mu.Unlock()
	if !contains(diags, "undelivered_on_shutdown") {
		t.Fatalf("diagnostics %v", diags)
	}
}

func TestTraceQueryAndRun(t *testing.T) {
	in := newIngest(t)
	c := newClient(t, in)
	ctx, _ := NewScope(context.Background())
	_ = c.TraceQuery(ctx, "SELECT * FROM users WHERE email = 'a@b.c' AND id = 7", "postgresql", time.Nanosecond, func() error {
		time.Sleep(time.Millisecond)
		return nil
	})
	if err := c.Run(ctx, "job.step", func(context.Context) error { return errors.New("step failed") }); err == nil {
		t.Fatal("Run must return the error")
	}
	c.Flush(context.Background())
	traces := in.items("traces")
	if traces[0]["span"] != "SELECT * FROM users WHERE email = ? AND id = ?" || traces[0]["type"] != "db" || traces[0]["status"] != "warn" {
		t.Fatalf("db span %v", traces[0])
	}
	if traces[1]["status"] != "err" {
		t.Fatalf("run span %v", traces[1])
	}
}

func TestFlagsTargetingAndRefresh(t *testing.T) {
	in := newIngest(t)
	c := newClient(t, in)
	c.RefreshFlags(context.Background())
	if !c.IsEnabled(context.Background(), "beta", FlagContext{"plan": "pro"}) {
		t.Fatal("beta should be on for pro")
	}
	if c.IsEnabled(context.Background(), "beta", FlagContext{"plan": "free"}) {
		t.Fatal("beta should be off for free")
	}
	if c.Variant(context.Background(), "missing", nil) != "control" {
		t.Fatal("unknown flags are control")
	}
}

func TestNormalisePathAndSQL(t *testing.T) {
	cases := map[string]string{
		"/users/42/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301": "/users/:id/orders/:id",
		"/objects/507f1f77bcf86cd799439011/":                    "/objects/:id",
		"/v2/items?token=x":                                     "/v2/items",
		"/a/1/2/3":                                              "/a/:id/:id/:id",
	}
	for in, want := range cases {
		if got := NormalisePath(in); got != want {
			t.Errorf("NormalisePath(%q) = %q want %q", in, got, want)
		}
	}
	if got := SanitizeSQL("UPDATE t SET a = $1 WHERE b IN (1, 2)"); got != "UPDATE t SET a = $1 WHERE b IN (?)" {
		t.Errorf("SanitizeSQL = %q", got)
	}
}
