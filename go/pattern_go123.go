//go:build go1.23

package watchup

import "net/http"

// requestPattern returns the ServeMux pattern that matched (Go 1.23+).
func requestPattern(r *http.Request) string { return r.Pattern }
