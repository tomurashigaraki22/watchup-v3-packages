package watchup

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

// FlagBucket returns the 0–99 rollout bucket for a user. It matches every other
// WatchUp SDK (djb2-xor over UTF-16 code units).
func FlagBucket(flagKey, userID string) int {
	var h uint32 = 5381
	for _, unit := range utf16.Encode([]rune(flagKey + ":" + userID)) {
		h = (h * 33) ^ uint32(unit)
	}
	return int(h % 100)
}

type featureFlag struct {
	Key               string  `json:"key"`
	Enabled           bool    `json:"enabled"`
	RolloutPercentage float64 `json:"rollout_percentage"`
	Variants          []struct {
		Key    string  `json:"key"`
		Weight float64 `json:"weight"`
	} `json:"variants"`
	TargetingRules []struct {
		Attribute string   `json:"attribute"`
		Operator  string   `json:"operator"`
		Values    []string `json:"values"`
	} `json:"targeting_rules"`
}

// FlagContext carries the attributes flags are evaluated against.
type FlagContext map[string]any

type flagStore struct {
	mu        sync.RWMutex
	flags     map[string]featureFlag
	fetchedAt time.Time
	maxAge    time.Duration
}

func newFlagStore() *flagStore {
	return &flagStore{flags: map[string]featureFlag{}, maxAge: 24 * time.Hour}
}

func (s *flagStore) replace(flags []featureFlag) {
	m := make(map[string]featureFlag, len(flags))
	for _, f := range flags {
		m[f.Key] = f
	}
	s.mu.Lock()
	s.flags, s.fetchedAt = m, time.Now()
	s.mu.Unlock()
}

func (s *flagStore) get(key string) (featureFlag, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.fetchedAt.IsZero() || time.Since(s.fetchedAt) > s.maxAge {
		return featureFlag{}, false
	}
	f, ok := s.flags[key]
	return f, ok
}

func matches(f featureFlag, ctx FlagContext) bool {
	for _, rule := range f.TargetingRules {
		val := ""
		if v, ok := ctx[rule.Attribute]; ok && v != nil {
			val = fmt.Sprint(v)
		}
		contains := func() bool {
			for _, v := range rule.Values {
				if v == val {
					return true
				}
			}
			return false
		}
		switch rule.Operator {
		case "in":
			if !contains() {
				return false
			}
		case "not_in":
			if contains() {
				return false
			}
		case "contains":
			found := false
			for _, v := range rule.Values {
				if strings.Contains(val, v) {
					found = true
				}
			}
			if !found {
				return false
			}
		case "equals":
			if len(rule.Values) == 0 || rule.Values[0] != val {
				return false
			}
		}
	}
	return true
}

func (c *Client) flagContext(ctx context.Context, fc FlagContext) FlagContext {
	out := FlagContext{}
	if u := c.userFor(ctx); u != nil {
		out["userId"] = u["id"]
		if e, ok := u["email"]; ok {
			out["email"] = e
		}
	}
	for k, v := range fc {
		out[k] = v
	}
	return out
}

func userKey(fc FlagContext) string {
	for _, k := range []string{"userId", "email"} {
		if v, ok := fc[k]; ok && v != nil && fmt.Sprint(v) != "" {
			return fmt.Sprint(v)
		}
	}
	return ""
}

// IsEnabled evaluates a feature flag locally (cache refreshed every 30s).
func (c *Client) IsEnabled(ctx context.Context, key string, fc FlagContext) bool {
	f, ok := c.flags.get(key)
	if !ok || !f.Enabled {
		return false
	}
	merged := c.flagContext(ctx, fc)
	if !matches(f, merged) {
		return false
	}
	if f.RolloutPercentage >= 100 {
		return true
	}
	if f.RolloutPercentage <= 0 {
		return false
	}
	id := userKey(merged)
	return id != "" && float64(FlagBucket(key, id)) < f.RolloutPercentage
}

// Variant returns the multivariate flag variant, or "control" when off.
func (c *Client) Variant(ctx context.Context, key string, fc FlagContext) string {
	if !c.IsEnabled(ctx, key, fc) {
		return "control"
	}
	f, _ := c.flags.get(key)
	if len(f.Variants) == 0 {
		return "on"
	}
	bucket := 0
	if id := userKey(c.flagContext(ctx, fc)); id != "" {
		bucket = FlagBucket(key, id)
	}
	cumulative := 0.0
	for _, v := range f.Variants {
		cumulative += v.Weight
		if float64(bucket) < cumulative {
			return v.Key
		}
	}
	return f.Variants[len(f.Variants)-1].Key
}

// RefreshFlags fetches flags now; on failure the cache is kept.
func (c *Client) RefreshFlags(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.opts.BaseURL+"/api/v1/flags", nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+c.opts.APIKey)
	req.Header.Set("X-Api-Key", c.opts.APIKey)
	resp, err := c.opts.HTTPClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var body struct {
		OK   bool `json:"ok"`
		Data struct {
			Flags []featureFlag `json:"flags"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&body) != nil || !body.OK {
		return
	}
	c.flags.replace(body.Data.Flags)
}

func (c *Client) pollFlags() {
	c.RefreshFlags(context.Background())
	ticker := time.NewTicker(c.opts.FlagRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stopFlags:
			return
		case <-ticker.C:
			c.RefreshFlags(context.Background())
		}
	}
}
