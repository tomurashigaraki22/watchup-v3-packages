package watchup

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type transport struct {
	url     string
	apiKey  string
	client  *http.Client
	timeout time.Duration
}

func (t *transport) send(ctx context.Context, c *Chunk) SendResult {
	ctx, cancel := context.WithTimeout(ctx, t.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, strings.NewReader(c.Body))
	if err != nil {
		return SendResult{Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("X-Api-Key", t.apiKey)
	req.Header.Set("Idempotency-Key", c.IdempotencyKey)
	req.Header.Set("User-Agent", SDKName+"/"+SDKVersion)

	resp, err := t.client.Do(req)
	if err != nil {
		return SendResult{Err: err}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return SendResult{OK: true, Status: resp.StatusCode}
	}
	res := SendResult{Status: resp.StatusCode, RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"))}
	var parsed struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Code != "" {
		res.Code = parsed.Code
	} else if resp.StatusCode == http.StatusRequestEntityTooLarge {
		res.Code = "payload_too_large"
	}
	return res
}

func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	var d time.Duration
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		d = time.Duration(secs * float64(time.Second))
	} else if at, err := http.ParseTime(v); err == nil {
		d = time.Until(at)
	}
	if d < 0 {
		return 0
	}
	if d > MaxRetryAfterMS*time.Millisecond {
		return MaxRetryAfterMS * time.Millisecond
	}
	return d
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
