// Contract workload for the Go SDK.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	watchup "github.com/tomurashigaraki22/watchup-go-sdk"
)

func main() {
	client, err := watchup.New(watchup.Options{
		APIKey: "wup_live_test", BaseURL: os.Getenv("WATCHUP_BASE_URL"), Environment: "contract",
		FlushInterval: time.Hour, FlagRefreshInterval: -1,
	})
	if err != nil {
		panic(err)
	}
	ctx := context.Background()
	client.SetUser(&watchup.User{ID: "contract-user"})
	client.CaptureError(ctx, errors.New(strings.Repeat("x", 256_000)), map[string]any{
		"headers": map[string]any{"Authorization": "Bearer secret-token-123"}, "password": "hunter2",
	})
	for i := 0; i < 3; i++ {
		client.Track(ctx, fmt.Sprintf("unicode-%d", i), map[string]any{"text": strings.Repeat("é", 60_000)})
	}
	for i := 0; i < 150; i++ {
		client.StartTrace(ctx, fmt.Sprintf("contract-trace-%d", i)).End("ok", 0, nil)
	}
	client.Flush(ctx)
	shutdown, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := client.Close(shutdown); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
