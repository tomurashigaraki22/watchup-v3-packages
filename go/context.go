package watchup

import (
	"context"
	"regexp"
	"strings"
	"sync"
)

// Scope is the per-request context carried in context.Context. The
// middleware creates one per request, so concurrent requests never share a
// user. Create one for background work with NewScope.
type Scope struct {
	RequestID string
	TraceID   string
	Method    string

	mu    sync.Mutex
	route string
	user  *User
}

type scopeKey struct{}

// NewScope returns ctx carrying a fresh scope (for jobs and consumers).
func NewScope(ctx context.Context) (context.Context, *Scope) {
	s := &Scope{RequestID: newUUID()}
	return context.WithValue(ctx, scopeKey{}, s), s
}

// ScopeFrom returns the request scope in ctx, or nil.
func ScopeFrom(ctx context.Context) *Scope { return scopeFrom(ctx) }

func scopeFrom(ctx context.Context) *Scope {
	if ctx == nil {
		return nil
	}
	s, _ := ctx.Value(scopeKey{}).(*Scope)
	return s
}

// SetUser attaches a user to the request scope in ctx. It returns false when
// ctx has no scope (use Client.SetUser for a process-wide default).
func SetUser(ctx context.Context, u *User) bool {
	s := scopeFrom(ctx)
	if s == nil {
		return false
	}
	s.mu.Lock()
	s.user = u
	s.mu.Unlock()
	return true
}

func (s *Scope) getUser() *User {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.user
}

func (s *Scope) setRoute(r string) {
	s.mu.Lock()
	s.route = r
	s.mu.Unlock()
}

func (s *Scope) getRoute() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.route
}

var (
	safeID      = regexp.MustCompile(`^[\w\-.:]{1,128}$`)
	traceparent = regexp.MustCompile(`(?i)^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$`)
)

func safeRequestID(v string) string {
	if safeID.MatchString(v) {
		return v
	}
	return ""
}

func traceIDFrom(v string) string {
	m := traceparent.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}
