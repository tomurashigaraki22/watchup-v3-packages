// Example: net/http with the WatchUp middleware (Go 1.22+ patterns).
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	watchup "github.com/tomurashigaraki22/watchup-go-sdk"
)

func main() {
	client, err := watchup.New(watchup.Options{
		APIKey:      os.Getenv("WATCHUP_API_KEY"),
		Environment: os.Getenv("APP_ENV"),
		Release:     os.Getenv("GIT_SHA"),
		Service:     "orders-api",
	})
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		watchup.SetUser(r.Context(), &watchup.User{ID: r.Header.Get("X-User-ID")})
		err := client.TraceQuery(r.Context(), "SELECT * FROM orders WHERE id = $1", "postgresql", 0, func() error {
			return nil // db.QueryRowContext(r.Context(), ...)
		})
		if err != nil {
			client.CaptureError(r.Context(), err, map[string]any{"order_id": r.PathValue("id")})
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	srv := &http.Server{Addr: ":8080", Handler: client.Middleware(mux)}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = client.Close(ctx) // flush what is left, bounded by the deadline
}
