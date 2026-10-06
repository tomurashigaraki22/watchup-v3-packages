//go:build !go1.23

package watchup

import "net/http"

// requestPattern is unavailable before Go 1.23; routes fall back to
// Options.Route or a normalised path.
func requestPattern(*http.Request) string { return "" }
