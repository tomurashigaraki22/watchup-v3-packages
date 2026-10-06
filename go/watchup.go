// Package watchup is the official WatchUp SDK for Go: error capture, request
// tracing, custom events, structured logs and feature flags, delivered in
// byte-aware batches to the WatchUp ingest API.
//
//	client, err := watchup.New(watchup.Options{APIKey: os.Getenv("WATCHUP_API_KEY")})
//	if err != nil { log.Fatal(err) }
//	defer client.Close(context.Background())
//
//	http.ListenAndServe(":8080", client.Middleware(mux))
package watchup

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// SDK identity sent as sdk.name / sdk.version in every envelope.
const (
	SDKName    = "watchup-go"
	SDKVersion = "0.1.0"
)

// Options configures a Client. Only APIKey is required.
type Options struct {
	APIKey      string
	BaseURL     string // default https://api.watchup.site
	Environment string // default $WATCHUP_ENVIRONMENT, then "production"
	Release     string
	Service     string

	FlushInterval time.Duration // default 5s
	MaxBatchSize  int           // items per request, max 100
	MaxQueueSize  int           // items kept while offline, default 1000
	// SampleRate is the fraction of requests traced (0–1]. Zero means 1.
	SampleRate float64
	// Timeout per ingest request. Default 8s.
	Timeout    time.Duration
	HTTPClient *http.Client

	RedactKeys   []string
	OnDiagnostic func(Diagnostic)
	Debug        bool
	Logger       *log.Logger

	// Logging enables CaptureLog; LogLevel is the lowest level sent.
	Logging  bool
	LogLevel string

	// FlagRefreshInterval: default 30s; negative disables flag polling.
	FlagRefreshInterval time.Duration

	// Route returns the route template for a request (e.g. chi's RoutePattern).
	// Defaults to the Go 1.22+ ServeMux pattern, then a normalised path.
	Route func(*http.Request) string
}

// User identifies the person behind a request.
type User struct {
	ID    string         `json:"id"`
	Email string         `json:"email,omitempty"`
	Name  string         `json:"name,omitempty"`
	Extra map[string]any `json:"-"`
}

func (u *User) toMap() map[string]any {
	if u == nil {
		return nil
	}
	m := map[string]any{"id": u.ID}
	for k, v := range u.Extra {
		m[k] = v
	}
	if u.Email != "" {
		m["email"] = u.Email
	}
	if u.Name != "" {
		m["name"] = u.Name
	}
	return m
}

// Client sends telemetry. It is safe for concurrent use.
type Client struct {
	opts      Options
	queue     *deliveryQueue
	flags     *flagStore
	transport *transport
	mu        sync.RWMutex
	user      *User
	closed    bool
	stopFlags chan struct{}
	closeOnce sync.Once
}

var logLevels = map[string]int{"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}

// New creates a client and starts its background delivery goroutine.
func New(opts Options) (*Client, error) {
	if opts.APIKey == "" {
		return nil, errors.New("watchup: APIKey is required (dashboard → Project Settings → API Keys)")
	}
	if opts.SampleRate < 0 || opts.SampleRate > 1 {
		return nil, errors.New("watchup: SampleRate must be between 0 and 1")
	}
	if opts.BaseURL == "" {
		opts.BaseURL = DefaultBaseURL
	}
	opts.BaseURL = strings.TrimRight(opts.BaseURL, "/")
	if opts.Environment == "" {
		opts.Environment = firstNonEmpty(os.Getenv("WATCHUP_ENVIRONMENT"), os.Getenv("WATCHUP_ENV"), "production")
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = 5 * time.Second
	}
	if opts.SampleRate == 0 {
		opts.SampleRate = 1
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 8 * time.Second
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{}
	}
	if opts.FlagRefreshInterval == 0 {
		opts.FlagRefreshInterval = 30 * time.Second
	}
	if _, ok := logLevels[opts.LogLevel]; !ok {
		opts.LogLevel = "debug"
	}

	c := &Client{opts: opts, flags: newFlagStore(), stopFlags: make(chan struct{})}
	c.transport = &transport{url: opts.BaseURL + ingestPath, apiKey: opts.APIKey, client: opts.HTTPClient, timeout: opts.Timeout}
	c.queue = newDeliveryQueue(queueOptions{
		send:          c.transport.send,
		base:          c.envelopeBase,
		maxItems:      opts.MaxBatchSize,
		maxQueueItems: opts.MaxQueueSize,
		redactKeys:    opts.RedactKeys,
		onDiagnostic:  c.diagnostic,
		autoFlush:     true,
	})
	c.queue.start(opts.FlushInterval)
	if opts.FlagRefreshInterval > 0 {
		go c.pollFlags()
	}
	return c, nil
}

func (c *Client) envelopeBase() map[string]any {
	base := map[string]any{"sdk": map[string]any{"name": SDKName, "version": SDKVersion}, "environment": c.opts.Environment}
	if c.opts.Release != "" {
		base["release"] = c.opts.Release
	}
	return base
}

func (c *Client) diagnostic(d Diagnostic) {
	if c.opts.Debug {
		logger := c.opts.Logger
		if logger == nil {
			logger = log.Default()
		}
		logger.Printf("[watchup] %s: %s", d.Type, d.Message)
	}
	if c.opts.OnDiagnostic != nil {
		c.opts.OnDiagnostic(d)
	}
}

func (c *Client) isClosed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.closed
}

// SetUser sets the default user for telemetry captured outside a request
// scope. Inside a request, use watchup.SetUser(ctx, user) instead.
func (c *Client) SetUser(u *User) {
	c.mu.Lock()
	c.user = u
	c.mu.Unlock()
}

func (c *Client) userFor(ctx context.Context) map[string]any {
	if s := scopeFrom(ctx); s != nil {
		if u := s.getUser(); u != nil {
			return u.toMap()
		}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.user.toMap()
}

func (c *Client) baseContext(ctx context.Context) map[string]any {
	out := map[string]any{"source": "server"}
	if c.opts.Service != "" {
		out["service"] = c.opts.Service
	}
	if s := scopeFrom(ctx); s != nil {
		out["request_id"] = s.RequestID
		if s.TraceID != "" {
			out["trace_id"] = s.TraceID
		}
	}
	return out
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// ── Capture ──────────────────────────────────────────────────────────────────

// CaptureError reports err with optional fields. A nil error is ignored.
func (c *Client) CaptureError(ctx context.Context, err error, fields map[string]any) {
	if err == nil || c.isClosed() {
		return
	}
	c.captureError(ctx, err, "error", "", string(debug.Stack()), fields)
}

func (c *Client) captureError(ctx context.Context, err error, level, route, stack string, fields map[string]any) {
	context := map[string]any{}
	for k, v := range fields {
		context[k] = v
	}
	for k, v := range c.baseContext(ctx) {
		context[k] = v
	}
	var chain []string
	for e := errors.Unwrap(err); e != nil && len(chain) < 5; e = errors.Unwrap(e) {
		chain = append(chain, e.Error())
	}
	if len(chain) > 0 {
		context["causes"] = chain
	}
	if route == "" {
		if s := scopeFrom(ctx); s != nil {
			route = s.getRoute()
		}
	}
	item := map[string]any{
		"message":     err.Error(),
		"type":        fmt.Sprintf("%T", err),
		"level":       level,
		"stack":       stack,
		"context":     context,
		"timestamp":   now(),
		"environment": c.opts.Environment,
	}
	if route != "" {
		item["route"] = route
	}
	if c.opts.Release != "" {
		item["release"] = c.opts.Release
	}
	if u := c.userFor(ctx); u != nil {
		item["user"] = u
	}
	c.queue.enqueue("errors", item)
}

// Track sends a custom analytics event.
func (c *Client) Track(ctx context.Context, name string, properties map[string]any) {
	if name == "" || c.isClosed() {
		return
	}
	props := c.baseContext(ctx)
	if u := c.userFor(ctx); u != nil {
		props["user"] = u
	}
	for k, v := range properties {
		props[k] = v
	}
	c.queue.enqueue("events", map[string]any{"name": name, "properties": props, "occurred_at": now()})
}

// CaptureLog sends a structured log (requires Options.Logging).
func (c *Client) CaptureLog(ctx context.Context, level, message string, fields map[string]any) {
	if c.isClosed() || !c.opts.Logging {
		return
	}
	weight, ok := logLevels[level]
	if !ok {
		level, weight = "info", logLevels["info"]
	}
	if weight < logLevels[c.opts.LogLevel] {
		return
	}
	props := map[string]any{}
	for k, v := range fields {
		props[k] = v
	}
	for k, v := range c.baseContext(ctx) {
		props[k] = v
	}
	props["message"] = message
	props["level"] = level
	props["runtime"] = map[string]any{"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH}
	if s := scopeFrom(ctx); s != nil && s.getRoute() != "" {
		props["route"] = s.getRoute()
	}
	if u := c.userFor(ctx); u != nil {
		props["user"] = u
	}
	c.queue.enqueue("events", map[string]any{"name": "log." + level, "properties": props, "occurred_at": now()})
}

// ── Traces ───────────────────────────────────────────────────────────────────

// Trace is an in-flight span. Call End exactly once (later calls are ignored).
type Trace struct {
	client  *Client
	ctx     context.Context
	span    string
	kind    string
	started time.Time
	once    sync.Once
}

// TraceOption customises StartTrace.
type TraceOption func(*Trace)

// WithType sets the trace type: "http", "function", "db" or "custom" (default).
func WithType(kind string) TraceOption { return func(t *Trace) { t.kind = kind } }

// StartTrace begins timing an operation.
func (c *Client) StartTrace(ctx context.Context, span string, opts ...TraceOption) *Trace {
	t := &Trace{client: c, ctx: ctx, span: span, kind: "custom", started: time.Now()}
	for _, o := range opts {
		o(t)
	}
	return t
}

// End records the trace. status is "ok", "warn" or "err"; statusCode 0 means
// derive 200/400/500 from status.
func (t *Trace) End(status string, statusCode int, meta map[string]any) {
	t.once.Do(func() {
		c := t.client
		if c.isClosed() {
			return
		}
		if status != "warn" && status != "err" {
			status = "ok"
		}
		if statusCode == 0 {
			statusCode = map[string]int{"ok": 200, "warn": 400, "err": 500}[status]
		}
		m := map[string]any{}
		for k, v := range meta {
			m[k] = v
		}
		for k, v := range c.baseContext(t.ctx) {
			m[k] = v
		}
		item := map[string]any{
			"span":        t.span,
			"type":        t.kind,
			"ms":          float64(time.Since(t.started).Microseconds()) / 1000,
			"status_code": statusCode,
			"status":      status,
			"timestamp":   t.started.UTC().Format("2006-01-02T15:04:05.000Z"),
			"environment": c.opts.Environment,
			"meta":        m,
		}
		if c.opts.Release != "" {
			item["release"] = c.opts.Release
		}
		if u := c.userFor(t.ctx); u != nil {
			item["user"] = u
		}
		c.queue.enqueue("traces", item)
	})
}

// Run times fn as a trace; a returned error marks it "err" and is passed through.
func (c *Client) Run(ctx context.Context, span string, fn func(context.Context) error) error {
	t := c.StartTrace(ctx, span, WithType("function"))
	err := fn(ctx)
	if err != nil {
		t.End("err", 0, nil)
		return err
	}
	t.End("ok", 0, nil)
	return nil
}

// TraceQuery records a database span around fn. The statement is sanitized
// (literals become ?, max 1 KiB); parameters are never recorded. Queries
// slower than slow (default 500ms) are marked "warn".
func (c *Client) TraceQuery(ctx context.Context, statement, system string, slow time.Duration, fn func() error) error {
	if slow <= 0 {
		slow = 500 * time.Millisecond
	}
	t := c.StartTrace(ctx, SanitizeSQL(statement), WithType("db"))
	meta := map[string]any{}
	if system != "" {
		meta["db_system"] = system
	}
	err := fn()
	switch {
	case err != nil:
		t.End("err", 0, meta)
	case time.Since(t.started) > slow:
		meta["slow"] = true
		t.End("warn", 0, meta)
	default:
		t.End("ok", 0, meta)
	}
	return err
}

// Recover captures a panic in a goroutine and re-panics. Use as
// `defer client.Recover(ctx)` at the top of background goroutines.
func (c *Client) Recover(ctx context.Context) {
	if r := recover(); r != nil {
		err, ok := r.(error)
		if !ok {
			err = fmt.Errorf("panic: %v", r)
		}
		c.captureError(ctx, err, "fatal", "", string(debug.Stack()), map[string]any{"mechanism": "panic"})
		c.Flush(context.Background())
		panic(r)
	}
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Flush sends everything queued now and blocks until the attempt finishes.
func (c *Client) Flush(ctx context.Context) FlushResult {
	return c.queue.flush(ctx, false)
}

// Close stops background goroutines and delivers queued items until ctx is
// done. Pass a context with a deadline to bound shutdown time.
func (c *Client) Close(ctx context.Context) error {
	var undelivered int
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		close(c.stopFlags)
		undelivered = c.queue.shutdown(ctx)
	})
	if undelivered > 0 {
		return fmt.Errorf("watchup: %d item(s) were not delivered before shutdown", undelivered)
	}
	return nil
}

func (c *Client) shouldSample() bool {
	return c.opts.SampleRate >= 1 || rand.Float64() < c.opts.SampleRate
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
