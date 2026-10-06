// Example: chi router. Route templates come from chi's RoutePattern.
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	watchup "github.com/tomurashigaraki22/watchup-go-sdk"
)

func main() {
	client, err := watchup.New(watchup.Options{
		APIKey: os.Getenv("WATCHUP_API_KEY"),
		Route: func(r *http.Request) string {
			if rc := chi.RouteContext(r.Context()); rc != nil {
				return rc.RoutePattern()
			}
			return ""
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	r := chi.NewRouter()
	r.Use(client.Middleware)
	r.Get("/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(chi.URLParam(r, "id")))
	})
	log.Fatal(http.ListenAndServe(":8080", r))
}
