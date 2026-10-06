package watchup

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
)

var (
	uuidSegment = regexp.MustCompile(`(?i)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/|$)`)
	hexSegment  = regexp.MustCompile(`(?i)/[0-9a-f]{24,64}(/|$)`)
	numSegment  = regexp.MustCompile(`/\d+(/|$)`)
)

// NormalisePath replaces ID-like path segments with :id so raw paths group.
func NormalisePath(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	if p == "" {
		p = "/"
	}
	for _, re := range []*regexp.Regexp{uuidSegment, hexSegment, numSegment} {
		for re.MatchString(p) {
			p = re.ReplaceAllString(p, "/:id$1")
		}
	}
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	return p
}

// statusWriter records the status code without changing what is written.
type statusWriter struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.written {
		w.status, w.written = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.written {
		w.status, w.written = http.StatusOK, true
	}
	return w.ResponseWriter.Write(b)
}

// Flush and Hijack keep streaming and websocket handlers working.
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("watchup: underlying ResponseWriter does not support hijacking")
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

var safeHeaders = []string{"User-Agent", "Content-Type", "Accept", "Referer", "Origin", "X-Request-ID", "X-Correlation-ID"}

func requestDetails(r *http.Request) map[string]any {
	headers := map[string]any{}
	for _, h := range safeHeaders {
		if v := r.Header.Get(h); v != "" {
			headers[strings.ToLower(h)] = v
		}
	}
	return map[string]any{"method": r.Method, "path": NormalisePath(r.URL.Path), "url": r.URL.RequestURI(), "headers": headers}
}

// Middleware wraps an http.Handler: one trace per request (route template and
// real status), a per-request Scope in the context, and panic capture. Panics
// are reported and then re-raised, so net/http (or your recovery middleware)
// handles them exactly as before.
func (c *Client) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, scope := NewScope(r.Context())
		if id := safeRequestID(r.Header.Get("X-Request-ID")); id != "" {
			scope.RequestID = id
		}
		scope.TraceID = traceIDFrom(r.Header.Get("traceparent"))
		scope.Method = r.Method
		c.mu.RLock()
		if c.user != nil {
			scope.user = c.user
		}
		c.mu.RUnlock()
		r = r.WithContext(ctx)

		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		sampled := c.shouldSample()
		start := time.Now()

		defer func() {
			rec := recover()
			status := sw.status
			if rec != nil {
				status = http.StatusInternalServerError
			}
			route := r.Method + " " + c.routeOf(r)
			scope.setRoute(route)
			if rec != nil && rec != http.ErrAbortHandler {
				err, ok := rec.(error)
				if !ok {
					err = fmt.Errorf("panic: %v", rec)
				}
				c.captureError(ctx, err, "error", route, string(debug.Stack()), map[string]any{"request": requestDetails(r), "mechanism": "panic"})
			}
			if sampled && !c.isClosed() {
				t := &Trace{client: c, ctx: ctx, span: route, kind: "http", started: start}
				st := "ok"
				if status >= 500 {
					st = "err"
				} else if status >= 400 {
					st = "warn"
				}
				t.End(st, status, map[string]any{"method": r.Method, "path": NormalisePath(r.URL.Path)})
			}
			if rec != nil {
				panic(rec)
			}
		}()

		next.ServeHTTP(sw, r)
	})
}

func (c *Client) routeOf(r *http.Request) string {
	if c.opts.Route != nil {
		if route := c.opts.Route(r); route != "" {
			return route
		}
	}
	if p := requestPattern(r); p != "" {
		// Go 1.22+ ServeMux patterns may include the method: "GET /items/{id}".
		if i := strings.IndexByte(p, ' '); i >= 0 {
			p = p[i+1:]
		}
		// Strip a host prefix ("example.com/items").
		if i := strings.IndexByte(p, '/'); i > 0 {
			p = p[i:]
		}
		return p
	}
	return NormalisePath(r.URL.Path)
}
